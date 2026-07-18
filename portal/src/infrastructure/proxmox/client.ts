import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { NodeHttpClient } from "@effect/platform-node"
import { Clock, Config, Effect, Either, Layer, Option, Redacted, Schema } from "effect"
import type { ConfigError } from "effect/ConfigError"
import type * as Https from "node:https"
import { ProvisionTimeout, ProxmoxError, ProxmoxPort } from "../../application/ports.js"
import { describeHttpFailure, requestPath } from "../httpClientErrors.js"

// Proxmox VE API(https://192.0.2.10:8006/api2/json)。トークン認証。
// spike メモ(docs/superpowers/research/2026-07-11-phase3-spike.md)で確定した
// 払い出しレシピを生 API で駆動する。node は eevee 固定(スペック上、単一ノード)。
// cloud-init の設定は「linked clone + PVE ネイティブの ciuser/sshkeys +
// ipconfig0」(既存 VM への鍵追加は guest-exec)。当初は cicustom で snippet
// (user-data)を差し込む案だったが、PVE 9.2 実機(Task 7)で
// `POST .../storage/local/upload` が
// `400 Parameter verification failed: content 'snippets' does not have a value
// in the enumeration 'iso, vztmpl, import'` を返すことを確認した。つまり
// snippets は API 経由でのアップロードができない(PVE 9.2 の制約)。
// snippet の唯一の役割は isucon ユーザー(NOPASSWD sudo・bash シェル・
// team の ssh_authorized_keys)の作成だったが、これは Ubuntu クラウドイメージの
// default_user 機構(NOPASSWD sudo 済みの既定ユーザーを cloud-init 経由で
// 用意する仕組み)と PVE ネイティブの ciuser/sshkeys パラメータだけで
// アップロード無しに実現できるため、configureCloudInit はそちらへ切り替える。

const NODE = "eevee"

// テンプレート VM(9100)上の Ubuntu クラウドイメージが cloud-init 経由で
// 用意する既定ユーザー名(NOPASSWD sudo 済み、実機 Task 7 で確認)。
// invites.ts の AUTHORIZED_KEYS_PATH(/home/isucon/...)と同じユーザーを指す
// 定数だが、application 層(usecases/invites.ts)と infrastructure 層
// (この proxmox クライアント)は別レイヤーの関心事であり、この 1 文字列のためだけに
// 共有モジュールを新設するほどの重複ではないため、ここではローカル定数として
// 個別に持つ。
const CLOUD_INIT_USER = "isucon"

// --- レスポンス Schema(必要フィールドのみ検証) ---

const UpidResponse = Schema.Struct({ data: Schema.String })

const TaskStatus = Schema.Struct({
  status: Schema.String,
  exitstatus: Schema.optional(Schema.String)
})
const TaskStatusResponse = Schema.Struct({ data: TaskStatus })

const ExecStartResponse = Schema.Struct({ data: Schema.Struct({ pid: Schema.Int }) })

const ExecStatus = Schema.Struct({
  exited: Schema.Int,
  exitcode: Schema.optional(Schema.Int),
  "out-data": Schema.optional(Schema.String)
})
const ExecStatusResponse = Schema.Struct({ data: ExecStatus })

const NodeStatusResponse = Schema.Struct({
  data: Schema.Struct({ memory: Schema.Struct({ free: Schema.Int }) })
})

// --- 汎用ポーリングヘルパー ---
// TestClock 経由で決定的にテストできるよう、Clock.currentTimeMillis で
// deadline を判定し、Effect.sleep で待つ(実 wall time に依存しない)。
//
// 単発の HTTP 呼び出し(attempt)がハングすると、deadline 判定は attempt 完了後にしか
// 行われないため、pollUntil 全体のタイムアウトが事実上効かなくなる。これを防ぐため、
// 個々の attempt を Effect.timeoutOption で縛る。attempt がタイムアウトした場合は
// 「まだ完了していない」扱いにして次のラウンド(次の attempt)へ進める(HTTP エラーや
// デコードエラーなど、attempt が実際に E で失敗した場合はそのまま fail させ、リトライしない)。
// 全体の deadline 超過は従来どおり onTimeout()。

const DEFAULT_ATTEMPT_TIMEOUT_MILLIS = 10_000

const pollUntil = <A, E>(opts: {
  attempt: Effect.Effect<A, E>
  isDone: (a: A) => boolean
  intervalMillis: number
  timeoutMillis: number
  onTimeout: () => E
  attemptTimeoutMillis?: number
}): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const deadline = yield* Clock.currentTimeMillis.pipe(Effect.map((now) => now + opts.timeoutMillis))
    const attemptTimeoutMillis = opts.attemptTimeoutMillis ?? DEFAULT_ATTEMPT_TIMEOUT_MILLIS
    const loop = (): Effect.Effect<A, E> =>
      Effect.gen(function* () {
        const outcome = yield* opts.attempt.pipe(Effect.timeoutOption(`${attemptTimeoutMillis} millis`))
        if (Option.isSome(outcome) && opts.isDone(outcome.value)) return outcome.value
        const now = yield* Clock.currentTimeMillis
        if (now >= deadline) return yield* Effect.fail(opts.onTimeout())
        yield* Effect.sleep(`${opts.intervalMillis} millis`)
        return yield* loop()
      })
    return yield* loop()
  })

const TASK_POLL_INTERVAL_MILLIS = 1_000
const TASK_POLL_TIMEOUT_MILLIS = 120_000
const GUEST_AGENT_POLL_INTERVAL_MILLIS = 2_000
const GUEST_EXEC_POLL_INTERVAL_MILLIS = 500
const GUEST_EXEC_POLL_TIMEOUT_MILLIS = 60_000

export const ProxmoxLive: Layer.Layer<ProxmoxPort, ConfigError, HttpClient.HttpClient> = Layer.effect(
  ProxmoxPort,
  Effect.gen(function* () {
    const apiUrl = yield* Config.string("PROXMOX_API_URL")
    const tokenId = yield* Config.string("PROXMOX_TOKEN_ID")
    const tokenSecret = yield* Config.redacted("PROXMOX_TOKEN_SECRET")
    const rawClient = yield* HttpClient.HttpClient
    const client = rawClient.pipe(
      HttpClient.mapRequest(
        HttpClientRequest.setHeader("authorization", `PVEAPIToken=${tokenId}=${Redacted.value(tokenSecret)}`)
      )
    )

    const nodeUrl = `${apiUrl}/nodes/${NODE}`

    // 2xx なら schema でデコード、それ以外は ProxmoxError。
    const request = <A>(
      req: HttpClientRequest.HttpClientRequest,
      schema: Schema.Schema<A, any>
    ): Effect.Effect<A, ProxmoxError> =>
      client.execute(req).pipe(
        Effect.mapError((cause) => new ProxmoxError({ cause: describeHttpFailure(req, cause) })),
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? HttpClientResponse.schemaBodyJson(schema)(response).pipe(
                Effect.mapError((cause) => new ProxmoxError({ cause: describeHttpFailure(req, cause) }))
              )
            : Effect.fail(
                new ProxmoxError({ cause: `Proxmox API ${req.method} ${requestPath(req)} → ${response.status}` })
              )
        ),
        Effect.scoped
      )

    // PVE 9 実機(Task 7 実機検証で確認)では、存在しない VM に対する
    // GET .../status/current(や、既に消えている VM への stop/delete)が
    // 404 ではなく HTTP 500 で返り、ボディは
    // {"data":null,"message":"Configuration file 'nodes/eevee/qemu-server/<vmid>.conf' does not exist\n"}
    // となる。404 のみを「存在しない」とみなす実装ではこの 500 がそのまま
    // 復旧不能な ProxmoxError として伝播し、自己サービス払い出しが
    // creating → failed で即死する(Task 7 で実際に踏んだ本番障害)。
    // そのため、404 に加えて「非 2xx かつボディがこの VM 設定ファイル欠落
    // メッセージに一致する」場合も「VM が存在しない」として扱う。
    // codex レビュー P1: 当初 /does not exist/i という広すぎるパターンで
    // マッチさせていたが、これだと stop/delete 中に起きた無関係なエラー
    // (例: "storage 'local' does not exist")まで VM 不在と誤認し、
    // テアダウンがインスタンスを deleted にする一方で VM 実体は残る(orphan
    // 化)・vmExists が誤って false を返し二重 clone を招く、という実害が
    // あった。そのため、上記メッセージの中核である
    // "Configuration file 'nodes/eevee/qemu-server/<vmid>.conf' does not exist"
    // の qemu-server/<数字>.conf という形の VM 設定ファイルパスにのみ限定して
    // マッチさせる。これに一致しない非 2xx(本当のサーバエラー等)は、
    // 従来通り ProxmoxError で fail させる。
    // 呼び出し側は 2xx をこの関数に渡さない前提(呼び出し前に 2xx 分岐済み)。
    const VM_MISSING_MESSAGE_PATTERN = /Configuration file '[^']*qemu-server\/\d+\.conf' does not exist/i

    const isVmMissingResponse = (
      response: HttpClientResponse.HttpClientResponse
    ): Effect.Effect<boolean> =>
      response.status === 404
        ? Effect.succeed(true)
        : response.text.pipe(
            Effect.map((text) => VM_MISSING_MESSAGE_PATTERN.test(text)),
            Effect.orElseSucceed(() => false)
          )

    // 冪等操作用。404(対象 VM が既に無い)、204(No Content = 待つべき
    // タスクが無い)、および上記の「500 + does not exist」はどれも None を返し、
    // それ以外の成功はボディの UPID を Some で返す。
    const requestUpidOrNotFound = (
      req: HttpClientRequest.HttpClientRequest
    ): Effect.Effect<Option.Option<string>, ProxmoxError> =>
      client.execute(req).pipe(
        Effect.mapError((cause) => new ProxmoxError({ cause: describeHttpFailure(req, cause) })),
        Effect.flatMap((response) => {
          if (response.status === 204) return Effect.succeed(Option.none<string>())
          if (response.status >= 200 && response.status < 300) {
            return HttpClientResponse.schemaBodyJson(UpidResponse)(response).pipe(
              Effect.map((r) => Option.some(r.data)),
              Effect.mapError((cause) => new ProxmoxError({ cause: describeHttpFailure(req, cause) }))
            )
          }
          return isVmMissingResponse(response).pipe(
            Effect.flatMap((missing) =>
              missing
                ? Effect.succeed(Option.none<string>())
                : Effect.fail(
                    new ProxmoxError({ cause: `Proxmox API ${req.method} ${requestPath(req)} → ${response.status}` })
                  )
            )
          )
        }),
        Effect.scoped
      )

    // 存在確認専用(vmExists)。404、および「500 + does not exist」を
    // 「存在しない」として吸収し、それ以外の非 2xx は復旧不能な ProxmoxError
    // にする(requestUpidOrNotFound と同じ判定だが、こちらはボディをデコード
    // せず有無だけを boolean で返す)。
    const requestExistsOrNotFound = (
      req: HttpClientRequest.HttpClientRequest
    ): Effect.Effect<boolean, ProxmoxError> =>
      client.execute(req).pipe(
        Effect.mapError((cause) => new ProxmoxError({ cause: describeHttpFailure(req, cause) })),
        Effect.flatMap((response) => {
          if (response.status >= 200 && response.status < 300) return Effect.succeed(true)
          return isVmMissingResponse(response).pipe(
            Effect.flatMap((missing) =>
              missing
                ? Effect.succeed(false)
                : Effect.fail(
                    new ProxmoxError({ cause: `Proxmox API ${req.method} ${requestPath(req)} → ${response.status}` })
                  )
            )
          )
        }),
        Effect.scoped
      )

    const requestConfig = (req: HttpClientRequest.HttpClientRequest): Effect.Effect<void, ProxmoxError> =>
      client.execute(req).pipe(
        Effect.mapError((cause) => new ProxmoxError({ cause: describeHttpFailure(req, cause) })),
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? Effect.void
            : Effect.fail(
                new ProxmoxError({ cause: `Proxmox API ${req.method} ${requestPath(req)} → ${response.status}` })
              )
        ),
        Effect.scoped
      )

    const pollTaskStatus = (upid: string) =>
      pollUntil({
        attempt: request(
          HttpClientRequest.get(`${apiUrl}/nodes/${NODE}/tasks/${encodeURIComponent(upid)}/status`),
          TaskStatusResponse
        ).pipe(Effect.map((r) => r.data)),
        isDone: (data) => data.status === "stopped",
        intervalMillis: TASK_POLL_INTERVAL_MILLIS,
        timeoutMillis: TASK_POLL_TIMEOUT_MILLIS,
        onTimeout: () => new ProxmoxError({ cause: `task ${upid} did not complete within timeout` })
      })

    const waitForTask = (upid: string) =>
      pollTaskStatus(upid).pipe(
        Effect.flatMap((data) =>
          data.exitstatus === "OK"
            ? Effect.void
            : Effect.fail(new ProxmoxError({ cause: `task ${upid} failed: exitstatus=${data.exitstatus}` }))
        )
      )

    const runTask = (req: HttpClientRequest.HttpClientRequest) =>
      request(req, UpidResponse).pipe(Effect.flatMap((r) => waitForTask(r.data)))

    // PVE 9 実機(Task 7 再検証)では、既に消えている VM への stop/delete が
    // 同期エラー(404 / 500 + does not exist)にならず、200 + UPID を返した上で
    // タスク自体が exitstatus="unable to find configuration file for VM <vmid>"
    // で失敗することがある(非同期版の「VM 不在」)。stopAndDestroyVm は冪等操作
    // なので、この特定パターンの task 失敗だけは「既に無い」= 成功として許容する。
    // vmid を組み込んだ正規表現でマッチさせ、無関係な task 失敗(本当の障害)を
    // 誤って握りつぶさないようにする。
    const vmMissingTaskExitstatusPattern = (vmid: number) =>
      new RegExp(`unable to find configuration file for VM ${vmid}\\b`, "i")

    const waitForTaskTolerateMissing = (vmid: number, upid: string) =>
      pollTaskStatus(upid).pipe(
        Effect.flatMap((data) => {
          if (data.exitstatus === "OK") return Effect.void
          if (data.exitstatus !== undefined && vmMissingTaskExitstatusPattern(vmid).test(data.exitstatus)) {
            return Effect.void
          }
          return Effect.fail(new ProxmoxError({ cause: `task ${upid} failed: exitstatus=${data.exitstatus}` }))
        })
      )

    const vmExistsEffect = (vmid: number): Effect.Effect<boolean, ProxmoxError> =>
      requestExistsOrNotFound(HttpClientRequest.get(`${nodeUrl}/qemu/${vmid}/status/current`))

    return {
      cloneVm: ({ name, newVmid, templateVmid }) =>
        runTask(
          HttpClientRequest.post(`${apiUrl}/nodes/${NODE}/qemu/${templateVmid}/clone`).pipe(
            HttpClientRequest.bodyUrlParams({ newid: newVmid, full: 0, name })
          )
        ),

      // PVE ネイティブの ciuser/sshkeys で cloud-init を設定する(snippet
      // アップロード無し、単一の config リクエスト)。
      // sshkeys の値は PVE の既知の慣習として、config に保存される時点で
      // percent-encode(RFC 3986)済みであることが要求される
      // (bpg/proxmox Terraform provider も同じ方式でエンコードしている)。
      // ここで encodeURIComponent したものを bodyUrlParams のパラメータ値として
      // 渡すため、実際の HTTP ボディ上ではさらにもう一段 form/url エンコードが
      // 掛かる(= 意図的な二重エンコード。PVE 側が受け取って一段 form-decode
      // した結果、ちょうど percent-encode 済みの sshkeys 文字列になる)。
      configureCloudInit: ({ gateway, ip, sshKeys, vmid }) =>
        requestConfig(
          HttpClientRequest.post(`${nodeUrl}/qemu/${vmid}/config`).pipe(
            HttpClientRequest.bodyUrlParams({
              ciuser: CLOUD_INIT_USER,
              sshkeys: encodeURIComponent(sshKeys.split("\n").map((k) => k.trim()).filter((k) => k !== "").join("\n")),
              ipconfig0: `gw=${gateway},ip=${ip}/24`,
              nameserver: "1.1.1.1"
            })
          )
        ),

      setVnet: ({ bridge, vmid }) =>
        requestConfig(
          HttpClientRequest.post(`${nodeUrl}/qemu/${vmid}/config`).pipe(
            HttpClientRequest.bodyUrlParams({ net0: `virtio,bridge=${bridge},firewall=0` })
          )
        ),

      startVm: (vmid) => runTask(HttpClientRequest.post(`${nodeUrl}/qemu/${vmid}/status/start`)),

      // 冪等: 対象 VM が既に存在しない場合は成功扱い。PVE 9 実機(Task 7)で
      // 2 通りの「VM 不在」が確認されている。
      // (1) 同期パス: stop/delete 自体が 404、または 500 +
      //     "Configuration file '...qemu-server/<vmid>.conf' does not exist"
      //     で返る(isVmMissingResponse / requestUpidOrNotFound が吸収)。
      // (2) 非同期パス(Task 7 再検証): 存在しない VM への stop が同期エラーに
      //     ならず 200 + UPID を返し、そのタスクを poll すると
      //     exitstatus="unable to find configuration file for VM <vmid>" で
      //     stopped する(waitForTaskTolerateMissing が吸収)。
      // さらに、そもそも VM が最初から存在しない(vmExists=false)場合は
      // stop/destroy のリクエスト自体を送らずに即成功させる(冪等操作の
      // 事前短絡。無用な API 呼び出しを避け、(1)(2)いずれの応答パターンにも
      // 依存しない最も確実な経路)。
      stopAndDestroyVm: (vmid) =>
        Effect.gen(function* () {
          const exists = yield* vmExistsEffect(vmid)
          if (!exists) return

          const stopUpid = yield* requestUpidOrNotFound(
            HttpClientRequest.post(`${nodeUrl}/qemu/${vmid}/status/stop`)
          )
          if (Option.isSome(stopUpid)) yield* waitForTaskTolerateMissing(vmid, stopUpid.value)

          const deleteUpid = yield* requestUpidOrNotFound(
            HttpClientRequest.del(`${nodeUrl}/qemu/${vmid}`).pipe(
              HttpClientRequest.setUrlParam("purge", "1")
            )
          )
          if (Option.isSome(deleteUpid)) yield* waitForTaskTolerateMissing(vmid, deleteUpid.value)
        }),

      // clone 再入可能性チェック用(Task 4 レビュー C1)。status/current は
      // 対象 VM が存在しない場合 404 を返すことが多いが、PVE 9 実機(Task 7)では
      // 500 + "Configuration file '...' does not exist" で返ることを確認済み
      // (requestExistsOrNotFound / isVmMissingResponse が両方を吸収する)。
      vmExists: (vmid) => vmExistsEffect(vmid),

      // guest agent 未起動時、Proxmox は agent/ping に 500(QEMU guest agent is not
      // running)を返す。これは「まだ ready でない」= リトライすべきケース。
      // 一方 401/403(トークン不正)・404(VM 不在)などそれ以外の非 2xx、および
      // client.execute 自体の失敗(ネットワーク層)は復旧不能なので pollUntil の
      // deadline を待たず ProxmoxError で即 fail させる(pollUntil はこの E を
      // 素通しし、false のときだけリトライする)。
      waitForGuestAgent: (vmid, timeoutMillis) =>
        pollUntil<boolean, ProxmoxError | ProvisionTimeout>({
          attempt: Effect.suspend(() => {
            const req = HttpClientRequest.post(`${nodeUrl}/qemu/${vmid}/agent/ping`)
            return client.execute(req).pipe(
              Effect.mapError((cause) => new ProxmoxError({ cause: describeHttpFailure(req, cause) })),
              Effect.flatMap((response) => {
                if (response.status >= 200 && response.status < 300) return Effect.succeed(true)
                if (response.status >= 500 && response.status < 600) return Effect.succeed(false)
                return Effect.fail(
                  new ProxmoxError({ cause: `Proxmox API ${req.method} ${requestPath(req)} → ${response.status}` })
                )
              }),
              Effect.scoped
            )
          }),
          isDone: (ready: boolean) => ready,
          intervalMillis: GUEST_AGENT_POLL_INTERVAL_MILLIS,
          timeoutMillis,
          onTimeout: () => new ProvisionTimeout({ vmid, timeoutMillis })
        }).pipe(Effect.asVoid),

      guestExec: ({ command, vmid }) =>
        Effect.gen(function* () {
          const started = yield* request(
            HttpClientRequest.post(`${nodeUrl}/qemu/${vmid}/agent/exec`).pipe(
              HttpClientRequest.bodyUrlParams({ command: [...command] })
            ),
            ExecStartResponse
          )
          const pid = started.data.pid
          const status = yield* pollUntil({
            attempt: request(
              HttpClientRequest.get(`${nodeUrl}/qemu/${vmid}/agent/exec-status`).pipe(
                HttpClientRequest.setUrlParam("pid", String(pid))
              ),
              ExecStatusResponse
            ).pipe(Effect.map((r) => r.data)),
            isDone: (data) => data.exited === 1,
            intervalMillis: GUEST_EXEC_POLL_INTERVAL_MILLIS,
            timeoutMillis: GUEST_EXEC_POLL_TIMEOUT_MILLIS,
            onTimeout: () => new ProxmoxError({ cause: `guestExec vmid=${vmid} pid=${pid} did not exit within timeout` })
          })
          return { exitcode: status.exitcode ?? -1, out: status["out-data"] ?? "" }
        }),

      getNodeFreeMemBytes: request(HttpClientRequest.get(`${nodeUrl}/status`), NodeStatusResponse).pipe(
        Effect.map((r) => r.data.memory.free)
      )
    }
  })
)

// --- TLS 方針(検証スキップを既定にしない。spike メモ §リスク2 の方針) ---
// PROXMOX_TLS_INSECURE=true の明示フラグが立っていればスキップ(既定は false)。
// それ以外は PROXMOX_TLS_FINGERPRINT(SHA256 フィンガープリント)でのピン留めを
// 必須にし、両方未設定なら安全側に倒して Layer 構築自体を失敗させる。

export type ProxmoxTlsPolicy =
  | { readonly _tag: "insecure" }
  | { readonly _tag: "pinned"; readonly fingerprint256: string }

// cert.fingerprint256 は "AA:BB:CC:..." 形式(コロン区切り大文字 hex)で得られる。
// PROXMOX_TLS_FINGERPRINT はコロン有無・大小を問わず受け付けたいので、
// 先頭の "SHA256:" プレフィックス・コロン・空白を除去し大文字化して正規化する。
const normalizeFingerprint = (fingerprint: string): string =>
  fingerprint.trim().toUpperCase().replace(/^SHA256:/, "").replace(/[:\s]/g, "")

export const resolveProxmoxTlsPolicy = (args: {
  insecure: boolean
  fingerprint: Option.Option<string>
}): Either.Either<ProxmoxTlsPolicy, ProxmoxError> => {
  if (args.insecure) return Either.right({ _tag: "insecure" })
  if (Option.isSome(args.fingerprint)) {
    return Either.right({ _tag: "pinned", fingerprint256: normalizeFingerprint(args.fingerprint.value) })
  }
  return Either.left(
    new ProxmoxError({
      cause:
        "PROXMOX_TLS_FINGERPRINT も PROXMOX_TLS_INSECURE=true も未設定。安全側に倒して TLS 設定の構築を拒否する。" +
        "eevee 証明書の SHA256 フィンガープリントを PROXMOX_TLS_FINGERPRINT に設定するか、" +
        "検証スキップを明示する場合のみ PROXMOX_TLS_INSECURE=true を設定すること。"
    })
  )
}

// checkServerIdentity 相当のフィンガープリント比較(純粋関数)。
// eevee は自己署名証明書のため、通常の CA チェーン検証は必ず失敗する。
// そのため pinned 分岐では rejectUnauthorized: false でチェーン検証自体をスキップし、
// その代わりに checkServerIdentity でこの関数を呼んで SHA256 フィンガープリントの
// 一致を必須にする(= チェーン検証はスキップするが、フィンガープリントが一致する
// 固定ホストのみ信頼する)。一致すれば undefined(Node の checkServerIdentity の
// 「OK」を表す規約)、不一致なら Error(ハンドシェイク拒否)を返す。
// 実 TLS ハンドシェイクを起こさずに検証できるよう、cert 全体ではなく
// fingerprint256 のみを引数に取る形で切り出している。
export const verifyFingerprintMatch = (
  expectedFingerprint256: string,
  actualFingerprint256: string | undefined
): Error | undefined => {
  const actual = normalizeFingerprint(actualFingerprint256 ?? "")
  return actual === expectedFingerprint256
    ? undefined
    : new Error(`Proxmox TLS fingerprint mismatch: expected ${expectedFingerprint256}, got ${actual}`)
}

// insecure(PROXMOX_TLS_INSECURE=true)分岐用のホスト限定チェック(純粋関数)。
// rejectUnauthorized: false は https.Agent 全体に効くため、この Layer が誤って
// Proxmox 以外の通信にも provide された場合、証明書検証が丸ごとスキップされてしまう
// (この Layer は PROXMOX_API_URL のホスト専用の HttpClient として provide される前提)。
// checkServerIdentity で接続先ホストを PROXMOX_API_URL のホストに限定することで、
// 想定外のホストへの接続はここで拒否する防御を入れる。
export const verifyInsecureHost = (expectedHost: string, actualHost: string): Error | undefined =>
  // DNS ホスト名は大小非区別。表記揺れだけで誤って拒否しないよう正規化して比較する。
  actualHost.toLowerCase() === expectedHost.toLowerCase()
    ? undefined
    : new Error(`PROXMOX_TLS_INSECURE is only permitted for host ${expectedHost}, got connection to ${actualHost}`)

// main.ts(Task 4/7 の Layer 合成)でこの Layer を HttpClient として provide する。
// checkServerIdentity を上書きしてホスト名/CA チェーン検証をフィンガープリント
// 一致確認に置き換える(自己署名証明書でも安全にピン留めできる)。
export const ProxmoxHttpClientLive: Layer.Layer<HttpClient.HttpClient, ConfigError | ProxmoxError> =
  Layer.unwrapEffect(
    Effect.gen(function* () {
      const insecure = yield* Config.boolean("PROXMOX_TLS_INSECURE").pipe(Config.withDefault(false))
      const fingerprint = yield* Config.option(Config.string("PROXMOX_TLS_FINGERPRINT"))
      const apiUrl = yield* Config.string("PROXMOX_API_URL")
      const policy = yield* Either.match(resolveProxmoxTlsPolicy({ insecure, fingerprint }), {
        onLeft: Effect.fail,
        onRight: Effect.succeed
      })
      const proxmoxHost = new URL(apiUrl).hostname

      // pinned: 自己署名証明書のピン留めの標準パターン(rejectUnauthorized: false +
      // checkServerIdentity でフィンガープリント一致を必須化)。rejectUnauthorized を
      // デフォルト(true)のままにすると、eevee の自己署名証明書は checkServerIdentity に
      // 到達する前に通常のチェーン検証で必ず失敗するため、ピン留めが機能しない。
      const agentOptions: Https.AgentOptions =
        policy._tag === "insecure"
          ? {
              rejectUnauthorized: false,
              checkServerIdentity: (host) => verifyInsecureHost(proxmoxHost, host)
            }
          : {
              rejectUnauthorized: false,
              // insecure 分岐と同様に、接続先ホストを PROXMOX_API_URL のホストに
              // 限定してからフィンガープリントを判定する(この Layer が誤って別
              // ホストへの HttpClient に provide された場合の防御)。
              checkServerIdentity: (host, cert) =>
                verifyInsecureHost(proxmoxHost, host) ??
                verifyFingerprintMatch(policy.fingerprint256, cert.fingerprint256)
            }

      return NodeHttpClient.layerWithoutAgent.pipe(Layer.provide(NodeHttpClient.makeAgentLayer(agentOptions)))
    })
  )
