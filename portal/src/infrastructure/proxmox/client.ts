import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { NodeHttpClient } from "@effect/platform-node"
import { Clock, Config, Effect, Either, Layer, Option, Redacted, Schema } from "effect"
import type { ConfigError } from "effect/ConfigError"
import type * as Https from "node:https"
import { ProvisionTimeout, ProxmoxError, ProxmoxPort } from "../../application/ports.js"
import { describeHttpFailure, requestPath } from "../httpClientErrors.js"

// Proxmox VE API(https://192.0.2.10:8006/api2/json)。トークン認証。
// spike メモ(docs/superpowers/research/2026-07-11-phase3-spike.md)で確定した
// 払い出しレシピ(linked clone + snippet(cicustom)+ ipconfig0、既存 VM への鍵追加
// は guest-exec)を生 API で駆動する。node は eevee 固定(スペック上、単一ノード)。

const NODE = "eevee"

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

// cloud-init snippet(user-data)。isucon ユーザー + ssh_authorized_keys を
// 固定で持つ(spike メモの実測済み形。sshKeys は 1 行 1 鍵の複数行文字列)。
const cloudInitSnippet = (sshKeys: string): string => {
  const keys = sshKeys
    .split("\n")
    .map((k) => k.trim())
    .filter((k) => k !== "")
  const keysYaml = keys.map((k) => `      - ${k}`).join("\n")
  return `#cloud-config
users:
  - name: isucon
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
${keysYaml}
`
}

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

    // 冪等操作用。404(対象 VM が既に無い)と 204(No Content = 待つべき
    // タスクが無い)はどちらも None を返し、それ以外の成功はボディの UPID を
    // Some で返す。
    const requestUpidOrNotFound = (
      req: HttpClientRequest.HttpClientRequest
    ): Effect.Effect<Option.Option<string>, ProxmoxError> =>
      client.execute(req).pipe(
        Effect.mapError((cause) => new ProxmoxError({ cause: describeHttpFailure(req, cause) })),
        Effect.flatMap((response) => {
          if (response.status === 404 || response.status === 204) return Effect.succeed(Option.none<string>())
          if (response.status < 200 || response.status >= 300) {
            return Effect.fail(
              new ProxmoxError({ cause: `Proxmox API ${req.method} ${requestPath(req)} → ${response.status}` })
            )
          }
          return HttpClientResponse.schemaBodyJson(UpidResponse)(response).pipe(
            Effect.map((r) => Option.some(r.data)),
            Effect.mapError((cause) => new ProxmoxError({ cause: describeHttpFailure(req, cause) }))
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

    const waitForTask = (upid: string) =>
      pollUntil({
        attempt: request(
          HttpClientRequest.get(`${apiUrl}/nodes/${NODE}/tasks/${encodeURIComponent(upid)}/status`),
          TaskStatusResponse
        ).pipe(Effect.map((r) => r.data)),
        isDone: (data) => data.status === "stopped",
        intervalMillis: TASK_POLL_INTERVAL_MILLIS,
        timeoutMillis: TASK_POLL_TIMEOUT_MILLIS,
        onTimeout: () => new ProxmoxError({ cause: `task ${upid} did not complete within timeout` })
      }).pipe(
        Effect.flatMap((data) =>
          data.exitstatus === "OK"
            ? Effect.void
            : Effect.fail(new ProxmoxError({ cause: `task ${upid} failed: exitstatus=${data.exitstatus}` }))
        )
      )

    const runTask = (req: HttpClientRequest.HttpClientRequest) =>
      request(req, UpidResponse).pipe(Effect.flatMap((r) => waitForTask(r.data)))

    return {
      cloneVm: ({ name, newVmid, templateVmid }) =>
        runTask(
          HttpClientRequest.post(`${apiUrl}/nodes/${NODE}/qemu/${templateVmid}/clone`).pipe(
            HttpClientRequest.bodyUrlParams({ newid: newVmid, full: 0, name })
          )
        ),

      configureCloudInit: ({ gateway, ip, sshKeys, vmid }) =>
        Effect.gen(function* () {
          const filename = `inucon-${vmid}.yaml`
          const formData = new FormData()
          formData.append("content", "snippets")
          formData.append(
            "filename",
            new Blob([cloudInitSnippet(sshKeys)], { type: "text/yaml" }),
            filename
          )
          yield* requestConfig(
            HttpClientRequest.post(`${apiUrl}/nodes/${NODE}/storage/local/upload`).pipe(
              HttpClientRequest.bodyFormData(formData)
            )
          )
          yield* requestConfig(
            HttpClientRequest.post(`${nodeUrl}/qemu/${vmid}/config`).pipe(
              HttpClientRequest.bodyUrlParams({
                cicustom: `user=local:snippets/${filename}`,
                ipconfig0: `gw=${gateway},ip=${ip}/24`,
                nameserver: "1.1.1.1"
              })
            )
          )
        }),

      setVnet: ({ bridge, vmid }) =>
        requestConfig(
          HttpClientRequest.post(`${nodeUrl}/qemu/${vmid}/config`).pipe(
            HttpClientRequest.bodyUrlParams({ net0: `virtio,bridge=${bridge},firewall=0` })
          )
        ),

      startVm: (vmid) => runTask(HttpClientRequest.post(`${nodeUrl}/qemu/${vmid}/status/start`)),

      // 冪等: stop/destroy いずれも対象 VM が既に存在しない(404)場合は成功扱い。
      stopAndDestroyVm: (vmid) =>
        Effect.gen(function* () {
          const stopUpid = yield* requestUpidOrNotFound(
            HttpClientRequest.post(`${nodeUrl}/qemu/${vmid}/status/stop`)
          )
          if (Option.isSome(stopUpid)) yield* waitForTask(stopUpid.value)

          const deleteUpid = yield* requestUpidOrNotFound(
            HttpClientRequest.del(`${nodeUrl}/qemu/${vmid}`).pipe(
              HttpClientRequest.setUrlParam("purge", "1")
            )
          )
          if (Option.isSome(deleteUpid)) yield* waitForTask(deleteUpid.value)
        }),

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
              checkServerIdentity: (_host, cert) => verifyFingerprintMatch(policy.fingerprint256, cert.fingerprint256)
            }

      return NodeHttpClient.layerWithoutAgent.pipe(Layer.provide(NodeHttpClient.makeAgentLayer(agentOptions)))
    })
  )
