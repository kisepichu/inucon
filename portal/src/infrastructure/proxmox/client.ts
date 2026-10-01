import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { NodeHttpClient } from "@effect/platform-node"
import { Clock, Config, Effect, Either, Layer, Option, Redacted, Schema } from "effect"
import type { ConfigError } from "effect/ConfigError"
import type * as Https from "node:https"
import type { ProxmoxInfrastructureInventory, VmInventoryItem } from "../../application/ports.js"
import { ModeTransitionTimeout, ProvisionTimeout, ProxmoxError, ProxmoxPort } from "../../application/ports.js"
import { BENCHVM_VMID, DEVVM_VMID, isModeVmid } from "../../domain/modeVmIds.js"
import { MANAGED_HOSTNAME_PATTERN } from "../../domain/reconciliation.js"
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

// Task 8: /nodes/:node/network の必要フィールドだけ。iface (bridge 名) と
// type ('bridge' 等) を持つ。type=bridge にのみ興味がある。
const NodeNetworkEntry = Schema.Struct({
  iface: Schema.String,
  type: Schema.optional(Schema.String)
})
const NodeNetworkResponse = Schema.Struct({ data: Schema.Array(NodeNetworkEntry) })

// 2026-10-01: /nodes/:node/network は /etc/network/interfaces 由来の classic
// bridge しか返さない。eevee の team1/team2 は Proxmox SDN の vnet
// (zone=inucon, type=simple)なのでこちらには現れない(実測: nic0/nic1/nic2/
// vmbr0/wlp4s0 の 5 件のみ)。vnet は /cluster/sdn/vnets に出るので両方を読む。
const SdnVnetEntry = Schema.Struct({
  vnet: Schema.String,
  zone: Schema.optional(Schema.String)
})
const SdnVnetsResponse = Schema.Struct({ data: Schema.Array(SdnVnetEntry) })

// Task 8: /nodes/:node/qemu/:vmid/config は任意のフィールドを返すため
// necessary な項目だけ抽出する。onboot は 0/1 の integer or string。
// name は inventory の name と一致する保証がないため config 側は無視する
// (list 側の name を使う)。net<N> は bridge=... を含む文字列。
const VmConfig = Schema.Record({
  key: Schema.String,
  value: Schema.Union(Schema.String, Schema.Int, Schema.Number, Schema.Null, Schema.Undefined)
}).annotations({ identifier: "VmConfig" })
const VmConfigResponse = Schema.Struct({ data: VmConfig })

// Task 8: /nodes/:node/services/:service/state。data.state が "running" のときだけ active 扱い。
const ServiceStateResponse = Schema.Struct({
  data: Schema.Struct({ state: Schema.String })
})

// Task 8: /nodes/:node/qemu/:vmid/status/current。status の string だけ使う。
const VmStatusCurrent = Schema.Struct({ status: Schema.String })
const VmStatusCurrentResponse = Schema.Struct({ data: VmStatusCurrent })

// Task 7 §Reconciliation: qemu 一覧の必要フィールドだけ抜き出す。
// PVE の GET /nodes/<node>/qemu は maxmem/mem/status/name/vmid/template を返す。
// template は既定 0(non-template)/1(template)で integer。managed VM の判定は
// 名前パターンで別途行うため、ここでは template を除外しないでそのまま受ける。
const VmListEntry = Schema.Struct({
  vmid: Schema.Int,
  name: Schema.optional(Schema.String),
  status: Schema.String,
  maxmem: Schema.optional(Schema.Union(Schema.Int, Schema.String)),
  template: Schema.optional(Schema.Union(Schema.Int, Schema.String)),
  // Task 8: qemu 一覧に onboot=0/1(integer or string)が含まれることがある。
  // getInfrastructureInventory は devvm/benchvm の onBoot をここから拾う
  // (存在しないときは qemu/:vmid/config を fallback で叩く)。
  onboot: Schema.optional(Schema.Union(Schema.Int, Schema.String))
})
const VmListResponse = Schema.Struct({ data: Schema.Array(VmListEntry) })

// review #4: 命名 filter は domain/reconciliation.ts の source-of-truth を再利用。

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


// Task 8: enter_contest_mode / return_normal_mode の graceful shutdown / start
// が扱う共通インフラ VM の vmid と、それによる credential dispatch。値の
// single source of truth は domain/modeVmIds.ts(review round 3 finding 3:
// app→infra の inverted re-export を避けるため domain 側に移した)。

// Task 8: waitForVmStatus のポーリング間隔。テストは TestClock.adjust で
// 進めるため wall time に依らない。
const VM_STATUS_POLL_INTERVAL_MILLIS = 1_000
// Task 8: split provision/mode credential.
//
// 「4 つすべて欠落 → legacy PROXMOX_TOKEN_ID/SECRET を両クライアントに配線」の
// rolling migration を許容し、それ以外は split を必須にする(部分設定は
// startup error)。final production は必ず split。以下の 3 ケースを扱う:
//   1. すべての split が揃う           → split を採用(legacy 併存でも split 優先)。
//   2. 4 つのうち一部だけ設定           → ConfigError で Layer 構築失敗(部分禁止)。
//   3. 4 つとも欠落かつ legacy が揃う   → legacy を両クライアントに配線
//                                        (secret-free deprecation warning を 1 度出す)。
//   4. 4 つとも欠落かつ legacy 欠落     → ConfigError(従来通り)。
//
// Config.option を使い、全部 all Some / all None を判定する(Config.string で
// 直に読むと欠落時に ConfigError で即 fail してしまい、legacy fallback に落ちない)。
interface ResolvedCredentials {
  readonly provisionTokenId: string
  readonly provisionTokenSecret: Redacted.Redacted
  readonly modeTokenId: string
  readonly modeTokenSecret: Redacted.Redacted
  readonly usedLegacyFallback: boolean
}

const readSplitCredentials: Effect.Effect<ResolvedCredentials, ConfigError> = Effect.gen(function* () {
  const provisionId = yield* Config.option(Config.string("PROXMOX_PROVISION_TOKEN_ID"))
  const provisionSecret = yield* Config.option(Config.redacted("PROXMOX_PROVISION_TOKEN_SECRET"))
  const modeId = yield* Config.option(Config.string("PROXMOX_MODE_TOKEN_ID"))
  const modeSecret = yield* Config.option(Config.redacted("PROXMOX_MODE_TOKEN_SECRET"))

  const splitSlots: ReadonlyArray<Option.Option<unknown>> = [provisionId, provisionSecret, modeId, modeSecret]
  const splitAllSet = splitSlots.every(Option.isSome)
  const splitAllUnset = splitSlots.every(Option.isNone)

  if (splitAllSet) {
    return {
      provisionTokenId: Option.getOrThrow(provisionId),
      provisionTokenSecret: Option.getOrThrow(provisionSecret),
      modeTokenId: Option.getOrThrow(modeId),
      modeTokenSecret: Option.getOrThrow(modeSecret),
      usedLegacyFallback: false
    }
  }

  if (!splitAllUnset) {
    // 部分設定は運用ミスの温床。Config.string で強制的に ConfigError にする。
    // 未設定のフィールドを最初に踏むまで読み進める(欠落名が cause に載る)。
    // string / redacted は Option の型が違うので 2 ループに分けて yield する。
    for (const [name, slot] of [
      ["PROXMOX_PROVISION_TOKEN_ID", provisionId],
      ["PROXMOX_MODE_TOKEN_ID", modeId]
    ] as const) {
      if (Option.isNone(slot)) yield* Config.string(name)
    }
    for (const [name, slot] of [
      ["PROXMOX_PROVISION_TOKEN_SECRET", provisionSecret],
      ["PROXMOX_MODE_TOKEN_SECRET", modeSecret]
    ] as const) {
      if (Option.isNone(slot)) yield* Config.redacted(name)
    }
    return yield* Effect.dieMessage("unreachable: partial Proxmox split credentials")
  }

  // すべての split が欠落 → legacy を両クライアントに配線する。
  const legacyId = yield* Config.string("PROXMOX_TOKEN_ID")
  const legacySecret = yield* Config.redacted("PROXMOX_TOKEN_SECRET")
  yield* Effect.logWarning(
    "PROXMOX_TOKEN_ID/PROXMOX_TOKEN_SECRET (legacy shared credential) is used for both provision and mode " +
      "operations. Configure PROXMOX_{PROVISION,MODE}_TOKEN_ID/SECRET to complete the split-credential migration."
  )
  return {
    provisionTokenId: legacyId,
    provisionTokenSecret: legacySecret,
    modeTokenId: legacyId,
    modeTokenSecret: legacySecret,
    usedLegacyFallback: true
  }
})

export const ProxmoxLive: Layer.Layer<ProxmoxPort, ConfigError, HttpClient.HttpClient> = Layer.effect(
  ProxmoxPort,
  Effect.gen(function* () {
    const apiUrl = yield* Config.string("PROXMOX_API_URL")
    // Task 9 review round 2 finding 2: pool は「Proxmox に存在するプールに
    // だけ渡す」optional 環境変数にする。Task 14 が inucon-team-vms プールを
    // 作るまで、旧環境や dev の Proxmox で clone が確実に 500 で落ちるのを
    // 避けるため。設定していれば毎 clone request の URL params に pool を
    // 積み、未設定なら pool パラメータ自体を送らない (Proxmox 側の
    // 「pool は任意」契約に依存)。
    const clonePool = yield* Config.option(Config.string("PROXMOX_CLONE_POOL"))
    const creds = yield* readSplitCredentials
    const rawClient = yield* HttpClient.HttpClient

    const authHeader = (tokenId: string, secret: Redacted.Redacted): string =>
      `PVEAPIToken=${tokenId}=${Redacted.value(secret)}`

    const withAuth = (tokenId: string, secret: Redacted.Redacted) =>
      rawClient.pipe(HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", authHeader(tokenId, secret))))

    const provisionClient = withAuth(creds.provisionTokenId, creds.provisionTokenSecret)
    const modeClient = withAuth(creds.modeTokenId, creds.modeTokenSecret)

    // ルーティング: 明示的に mode 側に投げるのは
    // (a) 共通インフラ VM(9200/9300)への操作、および
    // (b) node audit(/nodes/:node/status など)。
    // それ以外は provision client を使う(team VM / template)。
    const clientFor = (vmid: number) => (isModeVmid(vmid) ? modeClient : provisionClient)

    const nodeUrl = `${apiUrl}/nodes/${NODE}`

    // 2xx なら schema でデコード、それ以外は ProxmoxError。
    const requestWith = <A>(
      client: HttpClient.HttpClient,
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

    // 既存の compat: 単数 client(provision)向けの short form。
    const request = <A>(req: HttpClientRequest.HttpClientRequest, schema: Schema.Schema<A, any>) =>
      requestWith(provisionClient, req, schema)

    // PVE 9 実機(Task 7 実機検証で確認)では、存在しない VM に対する
    // GET .../status/current(や、既に消えている VM への stop/delete)が
    // 404 ではなく HTTP 500 で返り、ボディは
    // {"data":null,"message":"Configuration file 'nodes/eevee/qemu-server/<vmid>.conf' does not exist\n"}
    // となる。詳細は本 Layer 冒頭の記述参照(Task 4/7 実機検証)。
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

    const requestUpidOrNotFoundWith = (
      client: HttpClient.HttpClient,
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

    const requestExistsOrNotFound = (
      req: HttpClientRequest.HttpClientRequest
    ): Effect.Effect<boolean, ProxmoxError> =>
      provisionClient.execute(req).pipe(
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

    const requestConfigWith = (
      client: HttpClient.HttpClient,
      req: HttpClientRequest.HttpClientRequest
    ): Effect.Effect<void, ProxmoxError> =>
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

    // task 監視は provision credential でも mode credential でも成立する
    // (どちらも同じ /nodes/:node/tasks/:upid/status を叩ける)。呼び出し元と
    // 揃えるため、run 元と同じ client を使う。
    const pollTaskStatusWith = (client: HttpClient.HttpClient, upid: string) =>
      pollUntil({
        attempt: requestWith(
          client,
          HttpClientRequest.get(`${apiUrl}/nodes/${NODE}/tasks/${encodeURIComponent(upid)}/status`),
          TaskStatusResponse
        ).pipe(Effect.map((r) => r.data)),
        isDone: (data) => data.status === "stopped",
        intervalMillis: TASK_POLL_INTERVAL_MILLIS,
        timeoutMillis: TASK_POLL_TIMEOUT_MILLIS,
        onTimeout: () => new ProxmoxError({ cause: `task ${upid} did not complete within timeout` })
      })

    const waitForTaskWith = (client: HttpClient.HttpClient, upid: string) =>
      pollTaskStatusWith(client, upid).pipe(
        Effect.flatMap((data) =>
          data.exitstatus === "OK"
            ? Effect.void
            : Effect.fail(new ProxmoxError({ cause: `task ${upid} failed: exitstatus=${data.exitstatus}` }))
        )
      )

    const runTaskWith = (client: HttpClient.HttpClient, req: HttpClientRequest.HttpClientRequest) =>
      requestWith(client, req, UpidResponse).pipe(Effect.flatMap((r) => waitForTaskWith(client, r.data)))

    const vmMissingTaskExitstatusPattern = (vmid: number) =>
      new RegExp(`unable to find configuration file for VM ${vmid}\\b`, "i")

    const waitForTaskTolerateMissing = (vmid: number, upid: string) =>
      pollTaskStatusWith(provisionClient, upid).pipe(
        Effect.flatMap((data) => {
          if (data.exitstatus === "OK") return Effect.void
          if (data.exitstatus !== undefined && vmMissingTaskExitstatusPattern(vmid).test(data.exitstatus)) {
            return Effect.void
          }
          return Effect.fail(new ProxmoxError({ cause: `task ${upid} failed: exitstatus=${data.exitstatus}` }))
        })
      )

    // review round 2 finding 2: 「VM が既に停止している」ときの not-running を
    // 冪等な success として扱うための判定。対象 vmid を含む '(VM|qemu) <id>
    // (is )?not running' メッセージだけを許容し、無関係な 500 は素通しする。
    // 実機で観測される message 例:
    //   {"data":null,"message":"VM 9200 is not running\n"} (同期)
    //   task exitstatus="VM 9200 not running"                (非同期)
    const vmNotRunningMessagePattern = (vmid: number) =>
      new RegExp(`(?:VM|qemu) ${vmid}\\b[^\\n]*not running`, "i")

    const isVmNotRunningResponse = (
      vmid: number,
      response: HttpClientResponse.HttpClientResponse
    ): Effect.Effect<boolean> =>
      response.text.pipe(
        Effect.map((text) => vmNotRunningMessagePattern(vmid).test(text)),
        Effect.orElseSucceed(() => false)
      )


    const vmExistsEffect = (vmid: number): Effect.Effect<boolean, ProxmoxError> =>
      requestExistsOrNotFound(HttpClientRequest.get(`${nodeUrl}/qemu/${vmid}/status/current`))

    // Task 8: getInfrastructureInventory は次を単発で返す集約 endpoint。
    // - mode qemu list: devvm / benchvm の inventory 化。
    // - provision qemu list: template (9100) の存在確認。
    // - node network + SDN vnets: teamN として用意済みの N の集合。
    // - benchvm config: bridge=teamN が入っている net<N> の集合。
    // - node service inucon-team-isolation の state。
    // - node status の memory.free。
    //
    // credential のルーティング(2026-10-01 実機 ACL 実測に合わせて修正):
    //   /                     Administrator      terraform@pve
    //   /nodes/eevee          InuconNodeAudit    inucon-mode@pve
    //   /nodes/eevee          InuconNodeAudit    inucon-provision@pve
    //   /pool/inucon-team-vms InuconProvisionVm  inucon-provision@pve
    //   /storage/local-zfs    PVEDatastoreUser   inucon-provision@pve
    //   /vms/9200             InuconMode         inucon-mode@pve
    //   /vms/9300             InuconMode         inucon-mode@pve
    // つまり node audit (Sys.Audit) は **両ユーザー** が持つ(以前のコメントの
    // 「provision は Sys.Audit を持たない」は誤り)。一方 PVE は qemu 一覧を
    // ACL でフィルタするため、
    //   - mode token に見える VM  : 9200 / 9300 のみ(template 9100 は見えない)
    //   - provision token に見える: /pool/inucon-team-vms 配下(template 9100 を含む)
    // となる。どちらか片方の client では inventory 全体を観測できないので、
    // 用途ごとに client を使い分ける。
    //
    // 各 sub-request は optionalSubRead で Option に畳む。1 本の失敗を
    // inventory 全体の失敗に伝播させない(= その情報に依存する check だけが
    // degrade する)。
    const parseOnBoot = (v: unknown): boolean =>
      v === 1 || v === "1" || v === true

    const parseMaxmem = (v: unknown): number =>
      typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0

    const parseTemplate = (v: unknown): boolean =>
      v === 1 || v === "1" || v === true

    const vmInventoryFromList = (
      vms: ReadonlyArray<Schema.Schema.Type<typeof VmListEntry>>,
      vmid: number
    ): Option.Option<VmInventoryItem> => {
      const found = vms.find((v) => v.vmid === vmid)
      if (found === undefined || found.name === undefined) return Option.none()
      return Option.some({
        vmid: found.vmid,
        name: found.name,
        status: (found.status === "running" ? "running" : "stopped") as "running" | "stopped",
        memoryBytes: parseMaxmem(found.maxmem),
        onBoot: parseOnBoot(found.onboot)
      })
    }

    // inventory の sub-request を Option に畳む。失敗は「その 1 本が読めなかった」
    // だけの意味にし、inventory 全体は組み立て続ける。cause は describeHttpFailure
    // 由来(method + path + 要約のみ、credential を含まない)なので warn に出せる。
    const optionalSubRead = <A>(
      label: string,
      effect: Effect.Effect<A, ProxmoxError>
    ): Effect.Effect<Option.Option<A>> =>
      effect.pipe(
        Effect.tapError((error) =>
          Effect.logWarning(`Proxmox inventory sub-read '${label}' failed: ${error.cause}`)
        ),
        Effect.option
      )

    // benchvm の VM config を single request で読み、"net<N>" のうち
    // bridge=teamK が含まれるものの K だけ集める(intersection の benchvm 側)。
    const readBenchvmBridges: Effect.Effect<ReadonlyArray<number>, ProxmoxError> =
      requestWith(
        modeClient,
        HttpClientRequest.get(`${nodeUrl}/qemu/${BENCHVM_VMID}/config`),
        VmConfigResponse
      ).pipe(
        Effect.map((r) => {
          const acc: Array<number> = []
          for (const [k, v] of Object.entries(r.data)) {
            if (!/^net\d+$/.test(k) || typeof v !== "string") continue
            const m = v.match(/bridge=team(\d+)\b/)
            if (m !== null) acc.push(Number(m[1]))
          }
          return acc
        })
      )

    const teamNumbersOf = (names: ReadonlyArray<string>): ReadonlyArray<number> => {
      const acc: Array<number> = []
      for (const name of names) {
        const m = name.match(/^team(\d+)$/)
        if (m !== null) acc.push(Number(m[1]))
      }
      return acc
    }

    // classic bridge(/etc/network/interfaces 由来)の iface=teamN。
    const readNodeBridgeTeamNumbers: Effect.Effect<ReadonlyArray<number>, ProxmoxError> =
      requestWith(
        modeClient,
        HttpClientRequest.get(`${nodeUrl}/network`),
        NodeNetworkResponse
      ).pipe(Effect.map((r) => teamNumbersOf(r.data.map((n) => n.iface))))

    // SDN vnet(zone=inucon)の vnet=teamN。現行 eevee の team1/team2 はこちら。
    const readSdnVnetTeamNumbers: Effect.Effect<ReadonlyArray<number>, ProxmoxError> =
      requestWith(
        modeClient,
        HttpClientRequest.get(`${apiUrl}/cluster/sdn/vnets`),
        SdnVnetsResponse
      ).pipe(Effect.map((r) => teamNumbersOf(r.data.map((v) => v.vnet))))

    // node 側の「teamN が用意されている」観測。classic bridge と SDN vnet の
    // 和集合を取る(どちらの形でも運用でき、将来 classic に戻る可能性もある)。
    // 両方読めなかったときだけ None。片方だけ失敗したら読めた方を採用する。
    const readNodeTeamNumbers: Effect.Effect<Option.Option<ReadonlyArray<number>>> = Effect.gen(
      function* () {
        const [bridges, vnets] = yield* Effect.all(
          [
            optionalSubRead("node network bridges", readNodeBridgeTeamNumbers),
            optionalSubRead("cluster SDN vnets", readSdnVnetTeamNumbers)
          ],
          { concurrency: "unbounded" }
        )
        if (Option.isNone(bridges) && Option.isNone(vnets)) return Option.none()
        return Option.some([
          ...Option.getOrElse(bridges, (): ReadonlyArray<number> => []),
          ...Option.getOrElse(vnets, (): ReadonlyArray<number> => [])
        ])
      }
    )

    // isolation service state。404(= unit 未定義)だけを "inactive" 相当に
    // 畳み、それ以外の非 2xx / schema / ネットワーク失敗は ProxmoxError にする
    // (呼び出し側の optionalSubRead が None = 取得不能に畳む)。
    //
    // 2026-10-01 実測: PVE 9.2.3 は :service を固定 enum で検証するため、
    // カスタム unit には 404 ではなく HTTP 400 を返す
    // (errors.service = "value 'inucon-team-isolation' does not have a value in
    //  the enumeration 'chrony, corosync, cron, ...'")。unit 自体は eevee 上で
    // enabled かつ active なので、これは「サーバ異常」ではなく「この API では
    // 観測できない」。したがって 400 を "inactive" に畳むのは誤診(review round
    // 3 finding 2 と同じ理由)であり、None = 取得不能として readiness 側で warn
    // に落とす。/nodes/:node/services の一覧も同じ enum 由来の固定リストしか
    // 返さない(PVE::API2::Services の $service_list)ため代替にならない。
    const readIsolationServiceActive: Effect.Effect<boolean, ProxmoxError> = Effect.gen(function* () {
      const req = HttpClientRequest.get(`${nodeUrl}/services/inucon-team-isolation/state`)
      return yield* modeClient.execute(req).pipe(
        Effect.mapError((cause) => new ProxmoxError({ cause: describeHttpFailure(req, cause) })),
        Effect.flatMap((response) => {
          if (response.status === 404) return Effect.succeed(false)
          if (response.status >= 200 && response.status < 300) {
            return HttpClientResponse.schemaBodyJson(ServiceStateResponse)(response).pipe(
              Effect.map((r) => r.data.state === "running"),
              Effect.mapError((cause) => new ProxmoxError({ cause: describeHttpFailure(req, cause) }))
            )
          }
          return Effect.fail(
            new ProxmoxError({ cause: `Proxmox API ${req.method} ${requestPath(req)} → ${response.status}` })
          )
        }),
        Effect.scoped
      )
    })
    const readNodeFreeMemBytes: Effect.Effect<number, ProxmoxError> =
      requestWith(modeClient, HttpClientRequest.get(`${nodeUrl}/status`), NodeStatusResponse).pipe(
        Effect.map((r) => r.data.memory.free)
      )

    // 名前ベースで template / devvm / benchvm を探す。
    // - template は spec §Contest の 9100 固定(Contest.templateVmid のデフォルト値)。
    //   inventory 側の template=1 フラグと VMID の両方で識別できる。
    const TEMPLATE_VMID = 9100

    // template は /pool/inucon-team-vms 所属なので provision credential の
    // qemu 一覧にだけ現れる(mode token の ACL は /vms/9200 と /vms/9300 のみ)。
    const readTemplateExists: Effect.Effect<boolean, ProxmoxError> =
      requestWith(provisionClient, HttpClientRequest.get(`${nodeUrl}/qemu`), VmListResponse).pipe(
        Effect.map((r) => r.data.some((v) => v.vmid === TEMPLATE_VMID && parseTemplate(v.template)))
      )

    const getInfrastructureInventoryEffect: Effect.Effect<
      ProxmoxInfrastructureInventory,
      ProxmoxError
    > = Effect.gen(function* () {
      const [nodeFreeMemBytes, modeVms, templateExists, isolationActive, benchvmBridges, nodeTeamNumbers] =
        yield* Effect.all(
          [
            optionalSubRead("node status", readNodeFreeMemBytes),
            optionalSubRead(
              "mode qemu list",
              requestWith(modeClient, HttpClientRequest.get(`${nodeUrl}/qemu`), VmListResponse).pipe(
                Effect.map((r) => r.data)
              )
            ),
            optionalSubRead("provision qemu list (template)", readTemplateExists),
            optionalSubRead("isolation service state", readIsolationServiceActive),
            optionalSubRead("benchvm config bridges", readBenchvmBridges),
            readNodeTeamNumbers
          ],
          { concurrency: "unbounded" }
        )
      // preparedTeamNumbers は「node 側に teamN がある」∩「benchvm が teamN に
      // 足を持つ」。片方でも観測できなければ判定不能(None)。
      const preparedTeamNumbers = Option.map(
        Option.all([nodeTeamNumbers, benchvmBridges]),
        ([nodeNumbers, benchvmNumbers]): ReadonlyArray<number> => {
          const benchvmSet = new Set(benchvmNumbers)
          return [...new Set(nodeNumbers.filter((n) => benchvmSet.has(n)))].sort((a, b) => a - b)
        }
      )
      return {
        nodeFreeMemBytes,
        templateExists,
        devvm: Option.flatMap(modeVms, (vms) => vmInventoryFromList(vms, DEVVM_VMID)),
        benchvm: Option.flatMap(modeVms, (vms) => vmInventoryFromList(vms, BENCHVM_VMID)),
        preparedTeamNumbers,
        isolationServiceActive: isolationActive
      }
    })

    return {
      // Task 9: PROXMOX_CLONE_POOL が設定されていれば、その pool を毎 clone に
      // 付ける (least-privilege ACL の Task 14 と整合)。未設定なら pool 抜きで
      // 送る(既存 Proxmox に prohibitively を要求しない)。
      cloneVm: ({ name, newVmid, templateVmid }) => {
        const params: Record<string, string | number> = { newid: newVmid, full: 0, name }
        if (Option.isSome(clonePool)) params.pool = clonePool.value
        return runTaskWith(
          provisionClient,
          HttpClientRequest.post(`${apiUrl}/nodes/${NODE}/qemu/${templateVmid}/clone`).pipe(
            HttpClientRequest.bodyUrlParams(params)
          )
        )
      },

      configureCloudInit: ({ gateway, ip, sshKeys, vmid }) =>
        requestConfigWith(
          provisionClient,
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
        requestConfigWith(
          provisionClient,
          HttpClientRequest.post(`${nodeUrl}/qemu/${vmid}/config`).pipe(
            HttpClientRequest.bodyUrlParams({ net0: `virtio,bridge=${bridge},firewall=0` })
          )
        ),

      // startVm は mode/provision の両方から呼ばれる。vmid で client を選ぶ。
      startVm: (vmid) =>
        runTaskWith(clientFor(vmid), HttpClientRequest.post(`${nodeUrl}/qemu/${vmid}/status/start`)),

      stopAndDestroyVm: (vmid) =>
        Effect.gen(function* () {
          const exists = yield* vmExistsEffect(vmid)
          if (!exists) return

          const stopUpid = yield* requestUpidOrNotFoundWith(
            provisionClient,
            HttpClientRequest.post(`${nodeUrl}/qemu/${vmid}/status/stop`)
          )
          if (Option.isSome(stopUpid)) yield* waitForTaskTolerateMissing(vmid, stopUpid.value)

          const deleteUpid = yield* requestUpidOrNotFoundWith(
            provisionClient,
            HttpClientRequest.del(`${nodeUrl}/qemu/${vmid}`).pipe(
              HttpClientRequest.setUrlParam("purge", "1")
            )
          )
          if (Option.isSome(deleteUpid)) yield* waitForTaskTolerateMissing(vmid, deleteUpid.value)
        }),

      vmExists: (vmid) => vmExistsEffect(vmid),

      waitForGuestAgent: (vmid, timeoutMillis) =>
        pollUntil<boolean, ProxmoxError | ProvisionTimeout>({
          attempt: Effect.suspend(() => {
            const req = HttpClientRequest.post(`${nodeUrl}/qemu/${vmid}/agent/ping`)
            return provisionClient.execute(req).pipe(
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

      getNodeFreeMemBytes: readNodeFreeMemBytes,

      listManagedVms: requestWith(provisionClient, HttpClientRequest.get(`${nodeUrl}/qemu`), VmListResponse).pipe(
        Effect.map((r) =>
          r.data
            .filter((v) => v.name !== undefined && MANAGED_HOSTNAME_PATTERN.test(v.name))
            .map((v) => ({
              vmid: v.vmid,
              name: v.name as string,
              status: (v.status === "running" ? "running" : "stopped") as "running" | "stopped",
              memoryBytes: parseMaxmem(v.maxmem)
            }))
        )
      ),

      getInfrastructureInventory: getInfrastructureInventoryEffect,

      // Task 8: mode / setVmOnBoot は mode credential で叩く(共通インフラ VM の
      // config を書き換えるため InuconMode ACL が要る)。
      setVmOnBoot: (vmid, enabled) =>
        requestConfigWith(
          clientFor(vmid),
          HttpClientRequest.post(`${nodeUrl}/qemu/${vmid}/config`).pipe(
            HttpClientRequest.bodyUrlParams({ onboot: enabled ? 1 : 0 })
          )
        ),

      // Task 8: guest shutdown 発行。force stop 系(/status/stop)は絶対に呼ばない。
      //
      // review round 3 finding 1: 以前は shutdown task の完了まで待っていたが、
      // Proxmox の /status/shutdown task は内部の deadline (default 180s、
      // かつ `timeout` パラメータで上書き可能) を過ぎると exitstatus="VM
      // <id> is still running" で失敗する。この文字列は "not running" とは
      // 一致しないため waitForTaskTolerateNotRunning は素通しで ProxmoxError
      // を投げ、modeOperation の catchTag("ProxmoxError") が
      // OperationExecutionError に畳んで operation を **failed** に落として
      // しまう(spec §mode の "60s graceful → blocked (no force stop)" 経路が
      // 到達不能)。
      //
      // 修正: fire-and-forget にする。POST /status/shutdown?timeout=3600 で
      // ACPI signal を発行し、task 完了(= VM が実際に停止した)を待たない。
      // 実際の "60 秒 graceful deadline → blocked" 判定は wait_devvm_stopped
      // step の waitForVmStatus(status/current polling)が owner。task 側の
      // timeout は wait step の deadline より十分大きい値(3600s)にして、
      // wait step が blocked と判断するより先に task 側で強制失敗しないように
      // する。
      //
      // 冪等性: shutdown_devvm step は事前に inv.devvm.status を見て
      // 「stopped なら short-circuit」しているが、inventory 取得と
      // shutdownVm 発火の間で devvm が自然停止する race がある。Proxmox は
      // このとき同期エラーとして 500 + "VM <id> is not running" を返し得るので、
      // isVmNotRunningResponse で success 扱いに畳む(round 2 findings 対応の
      // 継続)。task 側の応答は待たないので、round 2 で追加した
      // waitForTaskTolerateNotRunning は shutdown からは呼ばない(dead)。
      shutdownVm: (vmid) =>
        Effect.gen(function* () {
          const client = clientFor(vmid)
          const req = HttpClientRequest.post(`${nodeUrl}/qemu/${vmid}/status/shutdown`).pipe(
            HttpClientRequest.bodyUrlParams({ timeout: 3600, forceStop: 0 })
          )
          yield* client.execute(req).pipe(
            Effect.mapError((cause) => new ProxmoxError({ cause: describeHttpFailure(req, cause) })),
            Effect.flatMap((response) => {
              if (response.status >= 200 && response.status < 300) return Effect.void
              return isVmNotRunningResponse(vmid, response).pipe(
                Effect.flatMap((notRunning) =>
                  notRunning
                    ? Effect.void
                    : Effect.fail(
                        new ProxmoxError({ cause: `Proxmox API ${req.method} ${requestPath(req)} → ${response.status}` })
                      )
                )
              )
            }),
            Effect.scoped
          )
        }),

      // Task 8: status/current を poll し、期待 status に達したら成功、
      // timeout に達したら ModeTransitionTimeout。ProxmoxError は素通し。
      waitForVmStatus: (vmid, expected, timeoutMillis) =>
        pollUntil<{ readonly status: string }, ProxmoxError | ModeTransitionTimeout>({
          attempt: requestWith(
            clientFor(vmid),
            HttpClientRequest.get(`${nodeUrl}/qemu/${vmid}/status/current`),
            VmStatusCurrentResponse
          ).pipe(Effect.map((r) => r.data)),
          isDone: (data) => data.status === expected,
          intervalMillis: VM_STATUS_POLL_INTERVAL_MILLIS,
          timeoutMillis,
          onTimeout: () => new ModeTransitionTimeout({ vmid, expected, timeoutMillis })
        }).pipe(Effect.asVoid)
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
