import { createHash } from "node:crypto"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { Config, Effect, Layer, Redacted, Schema } from "effect"
import type { ConfigError } from "effect/ConfigError"
import { AmbiguousAccessPolicy, CloudflareError, CloudflarePort } from "../../application/ports.js"
import { MANAGED_HOSTNAME_PATTERN } from "../../domain/reconciliation.js"
import { describeHttpFailure, requestPath } from "../httpClientErrors.js"

// Cloudflare API v4。Phase 1-2 は手動(ダッシュボード)で運用していた
// DNS CNAME / tunnel ingress / Access アプリの 3 操作を API 化する
// (スペック §アーキテクチャ、spike メモ §Step 6)。

const CF_API_BASE = "https://api.cloudflare.com/client/v4"

const DnsRecord = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  content: Schema.String
})

const DnsRecordsList = Schema.Array(DnsRecord)

const IngressEntry = Schema.Struct({
  hostname: Schema.optional(Schema.String),
  service: Schema.String
})
type IngressEntry = typeof IngressEntry.Type

const TunnelConfig = Schema.Struct({
  config: Schema.Struct({
    ingress: Schema.Array(IngressEntry)
  })
})

const AccessApp = Schema.Struct({
  id: Schema.String,
  domain: Schema.String
})

// email include のみ厳格にデコードする。everyone/ip/email_domain 等の他の include
// 種別は CF API 上多様な形を取り得るため、ここでは Schema.Unknown で受けて未知の形の
// まま保持する(厳格な Struct にすると、既存ポリシーにそれらが混在した瞬間に decode が
// 落ちてしまう)。email include かどうかの判定は isEmailInclude(Schema.is)で行う。
const AccessPolicyEmailInclude = Schema.Struct({
  email: Schema.Struct({ email: Schema.String })
})
const isEmailInclude = Schema.is(AccessPolicyEmailInclude)

const AccessPolicy = Schema.Struct({
  id: Schema.String,
  decision: Schema.String,
  include: Schema.Array(Schema.Unknown)
})

const AccessPoliciesList = Schema.Array(AccessPolicy)

// CF API v4 のレスポンスエンベロープ。2xx でもボディが `{success:false, errors:[...]}`
// になり得るため(例: レート制限・入力エラーの一部)、ステータスコードだけでなく
// このエンベロープの success を必ず検証する。success:true のときのみ result を
// resultSchema でデコードして使う。
const CfApiError = Schema.Struct({
  code: Schema.optional(Schema.Union(Schema.Number, Schema.String)),
  message: Schema.String
})

// success:false のとき result は null(あるいは省略)になり得るため、まずは
// result を Schema.Unknown で緩く受けて success/errors だけを確定させる。
// resultSchema による厳格なデコードは success:true が確定した後にだけ行う
// (success:false かつ result が薄い/null なケースで、resultSchema 側の
// decode 失敗が errors を覆い隠してしまわないようにするため)。
const CfEnvelope = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.optional(Schema.Array(CfApiError)),
  result: Schema.optional(Schema.Unknown),
  // ページング応答にだけ付く。形は endpoint ごとに揺れる(null も返り得る)
  // ので Unknown で受け、total_pages だけを後段で防御的に読む。
  result_info: Schema.optional(Schema.Unknown)
})

// CF API v4 の per_page は endpoint ごとに許可値が違う。2026-10-01 実測
// (各 3 回、完全に再現): /accounts/:id/access/apps は per_page=100/500/1000 が
// 200、101 と 5000 は 400(12091 access.api.error.invalid_url_parameter_value)。
// DNS 側は 5000 でも 200 が返るが、仕様外の値に依存する理由が無い。両方とも
// 100 件ずつ引き、result_info.total_pages まで辿って全件を取り切る
// (途中で打ち切ると reconciliation が resource を見落として誤った plan を出す)。
const CF_PAGE_SIZE = 100
// 暴走防止。100 件 × 1000 ページ = 10 万件で、INUCON の資源規模では到達しない。
const CF_MAX_PAGES = 1000

const readTotalPages = (resultInfo: unknown): number | null => {
  if (typeof resultInfo !== "object" || resultInfo === null) return null
  if (!("total_pages" in resultInfo)) return null
  const raw = resultInfo.total_pages
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : Number.NaN
  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : null
}

// Access app の `domain` は hostname とは限らない。実運用の同一アカウントには
// `dawarich.kisen.one/api/v1/*` のようなパス付き app が同居しており、先頭ラベル
// だけを見ると `inucon-team1-1.kisen.one/foo` のような app を managed hostname と
// 誤認し得る。bare hostname(英数字 + '-' + '.')のときだけ stem を返す。
const ACCESS_APP_HOSTNAME_PATTERN = /^[A-Za-z0-9.-]+$/

// トークンを含まない(cause は method + path + エラー要約のみ)success:false の
// 要約文字列を作る。errors が空の場合も success:false 自体を明示する。
const summarizeCfErrors = (
  req: HttpClientRequest.HttpClientRequest,
  errors: ReadonlyArray<{ readonly code?: number | string; readonly message: string }> | undefined
): string => {
  const detail =
    errors !== undefined && errors.length > 0
      ? errors.map((e) => (e.code !== undefined ? `${e.code}: ${e.message}` : e.message)).join("; ")
      : "(no error detail)"
  return `Cloudflare API ${req.method} ${requestPath(req)} → success:false — ${detail}`
}
// review #4: 命名 filter は domain/reconciliation.ts の source-of-truth を再利用。

export const CloudflareLive: Layer.Layer<CloudflarePort, ConfigError, HttpClient.HttpClient> = Layer.effect(
  CloudflarePort,
  Effect.gen(function* () {
    const apiToken = yield* Config.redacted("CF_API_TOKEN")
    const accountId = yield* Config.string("CF_ACCOUNT_ID")
    const zoneId = yield* Config.string("CF_ZONE_ID")
    const tunnelId = yield* Config.string("CF_TUNNEL_ID")
    const rawClient = yield* HttpClient.HttpClient
    const client = rawClient.pipe(
      HttpClient.mapRequest(
        HttpClientRequest.setHeader("authorization", `Bearer ${Redacted.value(apiToken)}`)
      )
    )

    // 2xx かつ success:true のときだけ result を resultSchema でデコードして返す。
    // 2xx でも success:false なら CloudflareError(errors の要約を cause に)。
    // 2xx 以外はステータスで即 fail。result_info.total_pages はページングを
    // 辿るためだけに返す(非ページング応答では null)。
    const requestPage = <A, I>(
      req: HttpClientRequest.HttpClientRequest,
      resultSchema: Schema.Schema<A, I>
    ): Effect.Effect<{ readonly result: A; readonly totalPages: number | null }, CloudflareError> =>
      client.execute(req).pipe(
        Effect.mapError((cause) => new CloudflareError({ cause: describeHttpFailure(req, cause) })),
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? HttpClientResponse.schemaBodyJson(CfEnvelope)(response).pipe(
                Effect.mapError((cause) => new CloudflareError({ cause: describeHttpFailure(req, cause) })),
                Effect.flatMap((envelope) =>
                  envelope.success
                    ? Schema.decodeUnknown(resultSchema)(envelope.result).pipe(
                        Effect.map((result) => ({ result, totalPages: readTotalPages(envelope.result_info) })),
                        Effect.mapError((cause) => new CloudflareError({ cause: describeHttpFailure(req, cause) }))
                      )
                    : Effect.fail(new CloudflareError({ cause: summarizeCfErrors(req, envelope.errors) }))
                )
              )
            : Effect.fail(
                new CloudflareError({ cause: `Cloudflare API ${req.method} ${requestPath(req)} → ${response.status}` })
              )
        ),
        Effect.scoped
      )

    const request = <A, I>(
      req: HttpClientRequest.HttpClientRequest,
      resultSchema: Schema.Schema<A, I>
    ): Effect.Effect<A, CloudflareError> =>
      requestPage(req, resultSchema).pipe(Effect.map((page) => page.result))

    // 一覧 endpoint を per_page=CF_PAGE_SIZE で全ページ取り切る。result_info が
    // 無い応答(= ページングしない endpoint / fake)は 1 ページで確定する。
    const requestAllPages = <A, I>(
      baseReq: HttpClientRequest.HttpClientRequest,
      itemSchema: Schema.Schema<A, I>
    ): Effect.Effect<ReadonlyArray<A>, CloudflareError> =>
      Effect.gen(function* () {
        const items: Array<A> = []
        for (let page = 1; page <= CF_MAX_PAGES; page++) {
          const { result, totalPages } = yield* requestPage(
            baseReq.pipe(
              HttpClientRequest.setUrlParam("per_page", String(CF_PAGE_SIZE)),
              HttpClientRequest.setUrlParam("page", String(page))
            ),
            Schema.Array(itemSchema)
          )
          items.push(...result)
          // result_info が無い応答(= ページングしない endpoint)は 1 ページで確定。
          if (totalPages === null || page >= totalPages) return items
          // まだ後続ページがあるはずなのに 0 件 — CF 側の race / 一過性エラーの
          // 可能性がある。黙って打ち切ると reconciliation が既存 resource を
          // 見落として重複作成する plan を出すので、fail-closed にする。
          if (result.length === 0) {
            return yield* Effect.fail(
              new CloudflareError({
                cause:
                  `Cloudflare API GET ${requestPath(baseReq)} → page ${page}/${totalPages} returned 0 items; ` +
                  "refusing to truncate inventory"
              })
            )
          }
        }
        return yield* Effect.fail(
          new CloudflareError({
            cause: `Cloudflare API GET ${requestPath(baseReq)} → exceeded ${CF_MAX_PAGES} pages; refusing to truncate inventory`
          })
        )
      })

    // PUT/POST/DELETE の void 系。result の形は見ず success だけ検証する
    // (DNS 削除等で result が薄い/null なケースも通す)。
    const requestJson = (
      req: HttpClientRequest.HttpClientRequest
    ): Effect.Effect<void, CloudflareError> =>
      client.execute(req).pipe(
        Effect.mapError((cause) => new CloudflareError({ cause: describeHttpFailure(req, cause) })),
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? HttpClientResponse.schemaBodyJson(CfEnvelope)(response).pipe(
                Effect.mapError((cause) => new CloudflareError({ cause: describeHttpFailure(req, cause) })),
                Effect.flatMap((envelope) =>
                  envelope.success
                    ? Effect.void
                    : Effect.fail(new CloudflareError({ cause: summarizeCfErrors(req, envelope.errors) }))
                )
              )
            : Effect.fail(
                new CloudflareError({ cause: `Cloudflare API ${req.method} ${requestPath(req)} → ${response.status}` })
              )
        ),
        Effect.scoped
      )

    const findDnsRecord = (hostname: string) =>
      request(
        HttpClientRequest.get(`${CF_API_BASE}/zones/${zoneId}/dns_records`).pipe(
          HttpClientRequest.setUrlParam("type", "CNAME"),
          HttpClientRequest.setUrlParam("name", hostname)
        ),
        DnsRecordsList
      ).pipe(
        // 同一 hostname の CNAME が複数ある(手動運用の残骸等)場合、黙って
        // 1 件だけ更新/削除すると経路が不安定になる。明示的に失敗させる。
        Effect.flatMap((records) =>
          records.length > 1
            ? Effect.fail(
                new CloudflareError({
                  cause: `DNS CNAME ${hostname} が ${records.length} 件見つかりました(重複)。手動で整理してください。`
                })
              )
            : Effect.succeed(records[0])
        )
      )

    // Task 9: upsert 後の DNS record ID を返す。既存があれば PUT、無ければ
    // POST。CF は body の name/content/proxied で更新するので、こちらは
    // record ID を portal 側の ResourceBinding に載せるだけで良い。
    const upsertDnsRecord = (hostname: string, content: string) =>
      Effect.gen(function* () {
        const existing = yield* findDnsRecord(hostname)
        const body = { type: "CNAME", name: hostname, content, proxied: true, ttl: 1 }
        if (existing !== undefined) {
          yield* requestJson(
            HttpClientRequest.put(`${CF_API_BASE}/zones/${zoneId}/dns_records/${existing.id}`).pipe(
              HttpClientRequest.bodyUnsafeJson(body)
            )
          )
          return existing.id
        }
        const created = yield* request(
          HttpClientRequest.post(`${CF_API_BASE}/zones/${zoneId}/dns_records`).pipe(
            HttpClientRequest.bodyUnsafeJson(body)
          ),
          DnsRecord
        )
        return created.id
      })

    const deleteDnsRecordIfExists = (hostname: string) =>
      Effect.gen(function* () {
        const existing = yield* findDnsRecord(hostname)
        if (existing === undefined) return
        yield* requestJson(
          HttpClientRequest.del(`${CF_API_BASE}/zones/${zoneId}/dns_records/${existing.id}`)
        )
      })

    const getIngress = () =>
      request(
        HttpClientRequest.get(`${CF_API_BASE}/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`),
        TunnelConfig
      ).pipe(Effect.map((cfg) => cfg.config.ingress))

    const putIngress = (ingress: ReadonlyArray<IngressEntry>) =>
      requestJson(
        HttpClientRequest.put(
          `${CF_API_BASE}/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`
        ).pipe(HttpClientRequest.bodyUnsafeJson({ config: { ingress } }))
      )

    // catch-all(hostname 未設定のエントリ)は末尾にあることを前提に、
    // 該当ホストのエントリを除去したうえでその直前に挿入する(既存エントリは全保持)。
    const upsertIngress = (hostname: string, service: string) =>
      Effect.gen(function* () {
        const current = yield* getIngress()
        const withoutHost = current.filter((e) => e.hostname !== hostname)
        const catchAllIndex = withoutHost.findIndex((e) => e.hostname === undefined)
        const insertAt = catchAllIndex === -1 ? withoutHost.length : catchAllIndex
        const updated = [
          ...withoutHost.slice(0, insertAt),
          { hostname, service },
          ...withoutHost.slice(insertAt)
        ]
        yield* putIngress(updated)
      })

    const removeIngress = (hostname: string) =>
      Effect.gen(function* () {
        const current = yield* getIngress()
        const updated = current.filter((e) => e.hostname !== hostname)
        if (updated.length === current.length) return
        yield* putIngress(updated)
      })

    // 「この hostname の app が既にあるか」。1 ページ目だけを見ると、account に
    // 他サービスの app が多いときに既存 app を見落として重複作成するため
    // 全ページを辿る(getInstanceInventory と同じ理由)。
    const findAccessApp = (hostname: string) =>
      requestAllPages(
        HttpClientRequest.get(`${CF_API_BASE}/accounts/${accountId}/access/apps`),
        AccessApp
      ).pipe(Effect.map((apps) => apps.find((a) => a.domain === hostname)))

    const getPolicies = (appId: string) =>
      request(
        HttpClientRequest.get(`${CF_API_BASE}/accounts/${accountId}/access/apps/${appId}/policies`),
        AccessPoliciesList
      )

    return {
      ensureInstanceRoute: ({ hostname, ip }) =>
        Effect.gen(function* () {
          const dnsRecordId = yield* upsertDnsRecord(hostname, `${tunnelId}.cfargotunnel.com`)
          yield* upsertIngress(hostname, `ssh://${ip}:22`)
          return { dnsRecordId }
        }),

      removeInstanceRoute: (hostname) =>
        Effect.gen(function* () {
          yield* deleteDnsRecordIfExists(hostname)
          yield* removeIngress(hostname)
        }),

      // Task 9: exact set semantics で Access アプリ + ポリシーを収束させる。
      //
      // - 呼び出し元が渡す `emails` を「trim + lowercase + dedupe + sort」して
      //   include の唯一の source of truth にする。過去エディションの email が
      //   include に残っていても消す(= no union with prior editions)。
      // - 既存 app のポリシー形状が「単一 allow + include が email のみ」で
      //   ない場合(手動追加された 2 つ目の allow policy、非 email include の
      //   混入など)は、上書きすると operator が入れた設定を破壊するため
      //   AmbiguousAccessPolicy を返して blocked にする。修復は operator の
      //   手動整理を要求する(readiness/reconciliation の runbook 通り)。
      // - emails=[] のとき: 新規 app なら policy を作らない(空 include は CF
      //   400、Task 7 実機検出)。既存 app の portal 所有 allow policy は
      //   DELETE する(deny-by-default に落ちる)。どちらも policyId=null 返却。
      ensureAccessAppExact: ({ hostname, emails }) =>
        Effect.gen(function* () {
          const normalized = Array.from(
            new Set(
              emails.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0)
            )
          ).sort()

          const existingApp = yield* findAccessApp(hostname)
          if (existingApp === undefined) {
            const app = yield* request(
              HttpClientRequest.post(`${CF_API_BASE}/accounts/${accountId}/access/apps`).pipe(
                HttpClientRequest.bodyUnsafeJson({
                  name: hostname,
                  domain: hostname,
                  type: "self_hosted",
                  session_duration: "24h"
                })
              ),
              AccessApp
            )
            if (normalized.length === 0) {
              return { appId: app.id, policyId: null } as { appId: string; policyId: string | null }
            }
            const created = yield* request(
              HttpClientRequest.post(
                `${CF_API_BASE}/accounts/${accountId}/access/apps/${app.id}/policies`
              ).pipe(
                HttpClientRequest.bodyUnsafeJson({
                  name: "inucon-team-members",
                  decision: "allow",
                  include: normalized.map((email) => ({ email: { email } }))
                })
              ),
              AccessPolicy
            )
            return { appId: app.id, policyId: created.id } as { appId: string; policyId: string | null }
          }

          const policies = yield* getPolicies(existingApp.id)
          const allowPolicies = policies.filter((p) => p.decision === "allow")

          // 「portal 所有シェイプ」の判定: allow policy が 0 か 1 かつ include が
          // 空でなく email のみ、または 0(= 未作成)を許容する。それ以外は
          // AmbiguousAccessPolicy として上書きせず operator に任せる。
          if (allowPolicies.length > 1) {
            return yield* Effect.fail(
              new AmbiguousAccessPolicy({ hostname, reason: "multiple_allow_policies" })
            )
          }
          const targetPolicy = allowPolicies.length === 1 ? allowPolicies[0] : undefined
          if (
            targetPolicy !== undefined &&
            targetPolicy.include.length > 0 &&
            !targetPolicy.include.every(isEmailInclude)
          ) {
            return yield* Effect.fail(
              new AmbiguousAccessPolicy({ hostname, reason: "non_email_include_present" })
            )
          }

          if (targetPolicy === undefined) {
            if (normalized.length === 0) {
              return { appId: existingApp.id, policyId: null } as { appId: string; policyId: string | null }
            }
            const created = yield* request(
              HttpClientRequest.post(
                `${CF_API_BASE}/accounts/${accountId}/access/apps/${existingApp.id}/policies`
              ).pipe(
                HttpClientRequest.bodyUnsafeJson({
                  name: "inucon-team-members",
                  decision: "allow",
                  include: normalized.map((email) => ({ email: { email } }))
                })
              ),
              AccessPolicy
            )
            return { appId: existingApp.id, policyId: created.id } as { appId: string; policyId: string | null }
          }

          // 既存 portal 所有 allow policy が存在。normalized=[] のときは削除、
          // それ以外は include を「exact に normalized」で PUT する(和集合しない)。
          if (normalized.length === 0) {
            yield* requestJson(
              HttpClientRequest.del(
                `${CF_API_BASE}/accounts/${accountId}/access/apps/${existingApp.id}/policies/${targetPolicy.id}`
              )
            )
            return { appId: existingApp.id, policyId: null } as { appId: string; policyId: string | null }
          }
          yield* requestJson(
            HttpClientRequest.put(
              `${CF_API_BASE}/accounts/${accountId}/access/apps/${existingApp.id}/policies/${targetPolicy.id}`
            ).pipe(
              HttpClientRequest.bodyUnsafeJson({
                name: "inucon-team-members",
                decision: "allow",
                include: normalized.map((email) => ({ email: { email } }))
              })
            )
          )
          return { appId: existingApp.id, policyId: targetPolicy.id } as { appId: string; policyId: string | null }
        }),

      removeAccessApp: (hostname) =>
        Effect.gen(function* () {
          const existingApp = yield* findAccessApp(hostname)
          if (existingApp === undefined) return
          yield* requestJson(
            HttpClientRequest.del(`${CF_API_BASE}/accounts/${accountId}/access/apps/${existingApp.id}`)
          )
        }),

      // Task 7 §Reconciliation: inucon-team\d+-\d+ prefix の DNS / ingress /
      // Access app + policies を横断し、hostname stem 単位に畳んで返す。
      // Access policy の include(email) は生値ではなく sorted+normalized(小文字化)
      // した集合の SHA-256 のみを返す(spec: "Access email 一覧を operation log /
      // response に残さない")。planner は emailSetHash で drift を検出できる。
      getInstanceInventory: Effect.gen(function* () {
        const allDns = yield* requestAllPages(
          HttpClientRequest.get(`${CF_API_BASE}/zones/${zoneId}/dns_records`).pipe(
            HttpClientRequest.setUrlParam("type", "CNAME")
          ),
          DnsRecord
        )
        const ingress = yield* getIngress()
        const apps = yield* requestAllPages(
          HttpClientRequest.get(`${CF_API_BASE}/accounts/${accountId}/access/apps`),
          AccessApp
        )

        const managedDns = allDns.filter((r) => {
          const stem = r.name.split(".")[0]
          return MANAGED_HOSTNAME_PATTERN.test(stem)
        })
        const routesByStem = new Map<string, {
          hostname: string
          dnsRecordIds: Array<string>
          ingressServices: Array<string>
        }>()
        const ensureRoute = (stem: string) => {
          const existing = routesByStem.get(stem)
          if (existing !== undefined) return existing
          const created = { hostname: stem, dnsRecordIds: [], ingressServices: [] }
          routesByStem.set(stem, created)
          return created
        }
        for (const r of managedDns) {
          ensureRoute(r.name.split(".")[0]).dnsRecordIds.push(r.id)
        }
        for (const e of ingress) {
          if (e.hostname === undefined) continue
          const stem = e.hostname.split(".")[0]
          if (!MANAGED_HOSTNAME_PATTERN.test(stem)) continue
          ensureRoute(stem).ingressServices.push(e.service)
        }

        // Access apps は domain(hostname)を持つ。同 hostname に複数 app が
        // 張られている場合は appIds に全 ID を積む(planner が ambiguous を検出)。
        // review round 8 #1: emailSetHash の集約は「全 per-app hash を集めきってから
        // sort + SHA-256 1 回」で確定する。以前の incremental fold は
        // 2 apps では commutative だが 3+ で CF API の返却順に依存し、同じ CF 状態でも
        // plan 間で hash が揺れて drift 検出が壊れていた。final hashing を loop の
        // 外に出せば app 数によらず決定的になる。
        interface AppStemAccum {
          readonly hostname: string
          readonly appIds: Array<string>
          policyShape: "owned_exact" | "unknown"
          readonly perAppHashes: Array<string>
        }
        const appsAccumByStem = new Map<string, AppStemAccum>()
        // review #3: getPolicies を管理対象 app 数だけ直列に叩くと 50 チーム
        // 規模で 10 秒台の inventory になり、CF rate limiter 429 も踏みやすい。
        // concurrency 10 で並列化しつつ、hostname 単位の集約は決定的に行う。
        // path 付き domain(`inucon-team1-1.kisen.one/api/*` など)は hostname
        // として扱わない。先頭ラベルだけを見ると portal 所有 app と誤認する。
        const managed = apps.filter((app) => {
          if (!ACCESS_APP_HOSTNAME_PATTERN.test(app.domain)) return false
          return MANAGED_HOSTNAME_PATTERN.test(app.domain.split(".")[0])
        })
        const fetched = yield* Effect.forEach(
          managed,
          (app) =>
            getPolicies(app.id).pipe(Effect.map((policies) => ({ app, policies }))),
          { concurrency: 10 }
        )
        for (const { app, policies } of fetched) {
          const stem = app.domain.split(".")[0]
          // 「owned_exact」= 1 個の allow policy かつ include が email のみで
          // 構成される、を満たす形。それ以外は unknown(誤って削除しない)。
          const allowPolicies = policies.filter((p) => p.decision === "allow")
          const only = allowPolicies.length === 1 ? allowPolicies[0] : undefined
          const emailsOnly =
            only !== undefined && only.include.length > 0 && only.include.every(isEmailInclude)
          const emails = emailsOnly && only !== undefined
            ? only.include
                .filter(isEmailInclude)
                .map((i) => i.email.email.trim().toLowerCase())
            : []
          const sortedUnique = Array.from(new Set(emails)).sort()
          // 生 email はここで即破棄する。perAppHash だけを蓄積する。
          const perAppHash = createHash("sha256").update(sortedUnique.join("\n")).digest("hex")
          const existing = appsAccumByStem.get(stem)
          if (existing === undefined) {
            appsAccumByStem.set(stem, {
              hostname: stem,
              appIds: [app.id],
              policyShape: emailsOnly ? "owned_exact" : "unknown",
              perAppHashes: [perAppHash]
            })
          } else {
            existing.appIds.push(app.id)
            existing.policyShape = "unknown"
            existing.perAppHashes.push(perAppHash)
          }
        }

        const appsByStem = Array.from(appsAccumByStem.values()).map((accum) => {
          // 1 app のときは per-app hash をそのまま使い、複数 app のときは全 hash を
          // sort して concat し SHA-256 で 1 回だけ潰す(順序非依存)。
          const emailSetHash =
            accum.perAppHashes.length === 1
              ? accum.perAppHashes[0]
              : createHash("sha256")
                  .update(accum.perAppHashes.slice().sort().join("|"))
                  .digest("hex")
          return {
            hostname: accum.hostname,
            appIds: accum.appIds,
            policyShape: accum.policyShape,
            emailSetHash
          }
        })

        return {
          routes: Array.from(routesByStem.values()),
          apps: appsByStem
        }
      }),

      // Task 8: readiness の cloudflare_token key が呼ぶ probe。
      // GET /user/tokens/verify のみを叩き、status=="active" を成功条件にする。
      // review round 1 finding 3: inventoryReadable フラグは常に true を返す
      // dead flag だったため型ごと廃止した。readiness の `cloudflare_inventory`
      // key は getInstanceInventory を独立に呼ぶ責務分離。
      probe: Effect.gen(function* () {
        const verifyReq = HttpClientRequest.get(`${CF_API_BASE}/user/tokens/verify`)
        yield* request(verifyReq, Schema.Struct({ status: Schema.String })).pipe(
          Effect.flatMap((result) =>
            result.status === "active"
              ? Effect.void
              : Effect.fail(new CloudflareError({ cause: `token status ${result.status}` }))
          )
        )
        return { tokenStatus: "active" as const }
      })
    }
  })
)

