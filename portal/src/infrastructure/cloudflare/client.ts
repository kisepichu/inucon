import { createHash } from "node:crypto"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { Config, Effect, Layer, Redacted, Schema } from "effect"
import type { ConfigError } from "effect/ConfigError"
import { CloudflareError, CloudflarePort } from "../../application/ports.js"
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

const AccessAppsList = Schema.Array(AccessApp)

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
  result: Schema.optional(Schema.Unknown)
})

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
    // 2xx 以外はステータスで即 fail。
    const request = <A, I>(
      req: HttpClientRequest.HttpClientRequest,
      resultSchema: Schema.Schema<A, I>
    ): Effect.Effect<A, CloudflareError> =>
      client.execute(req).pipe(
        Effect.mapError((cause) => new CloudflareError({ cause: describeHttpFailure(req, cause) })),
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? HttpClientResponse.schemaBodyJson(CfEnvelope)(response).pipe(
                Effect.mapError((cause) => new CloudflareError({ cause: describeHttpFailure(req, cause) })),
                Effect.flatMap((envelope) =>
                  envelope.success
                    ? Schema.decodeUnknown(resultSchema)(envelope.result).pipe(
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
        } else {
          yield* requestJson(
            HttpClientRequest.post(`${CF_API_BASE}/zones/${zoneId}/dns_records`).pipe(
              HttpClientRequest.bodyUnsafeJson(body)
            )
          )
        }
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

    const findAccessApp = (hostname: string) =>
      request(
        HttpClientRequest.get(`${CF_API_BASE}/accounts/${accountId}/access/apps`),
        AccessAppsList
      ).pipe(Effect.map((apps) => apps.find((a) => a.domain === hostname)))

    const getPolicies = (appId: string) =>
      request(
        HttpClientRequest.get(`${CF_API_BASE}/accounts/${accountId}/access/apps/${appId}/policies`),
        AccessPoliciesList
      )

    return {
      ensureInstanceRoute: ({ hostname, ip }) =>
        Effect.gen(function* () {
          yield* upsertDnsRecord(hostname, `${tunnelId}.cfargotunnel.com`)
          yield* upsertIngress(hostname, `ssh://${ip}:22`)
        }),

      removeInstanceRoute: (hostname) =>
        Effect.gen(function* () {
          yield* deleteDnsRecordIfExists(hostname)
          yield* removeIngress(hostname)
        }),

      // GET → 和集合 → PUT(締め出し防止。既存ポリシーの include を消さない)。
      //
      // emails が空のときはポリシーを書き込まない(Task 7 実機検出): CF は空の
      // include を 400 で拒否する。ポリシー無しのアプリは deny-by-default なので
      // 安全側であり、email は後から招待フロー(inviteMember →
      // syncRunningInstances → ensureAccessApp 再実行)が登録した時点でポリシー
      // が作られる。
      ensureAccessApp: ({ hostname, emails }) =>
        Effect.gen(function* () {
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
            if (emails.length === 0) return
            yield* requestJson(
              HttpClientRequest.post(
                `${CF_API_BASE}/accounts/${accountId}/access/apps/${app.id}/policies`
              ).pipe(
                HttpClientRequest.bodyUnsafeJson({
                  name: "inucon-team-members",
                  decision: "allow",
                  include: emails.map((email) => ({ email: { email } }))
                })
              )
            )
            return
          }

          const policies = yield* getPolicies(existingApp.id)

          // 前提(単一ポリシー想定の脆さへの対処): 実 API では複数ポリシー・複数種別の
          // include(everyone/ip/email_domain 等)が存在しうる。ここでは「先頭の allow
          // ポリシー」だけを inucon の対象ポリシーとみなし、email はその先頭 allow
          // ポリシーの email include とのみ和集合を取る。allow ポリシーが 1 つも無い
          // (0 個、または全て allow 以外)場合は新規に allow ポリシーを作成する。
          // 対象ポリシーの email 以外の include(everyone/ip 等)は unknown のまま
          // そのまま保持し、和集合の対象にも変更対象にもしない(消さない)。
          const targetPolicy = policies.find((p) => p.decision === "allow")

          if (targetPolicy === undefined) {
            // 空 include は CF 400(上記コメント)。email が来るまで作らない。
            if (emails.length === 0) return
            yield* requestJson(
              HttpClientRequest.post(
                `${CF_API_BASE}/accounts/${accountId}/access/apps/${existingApp.id}/policies`
              ).pipe(
                HttpClientRequest.bodyUnsafeJson({
                  name: "inucon-team-members",
                  decision: "allow",
                  include: emails.map((email) => ({ email: { email } }))
                })
              )
            )
            return
          }

          const currentEmails = targetPolicy.include.filter(isEmailInclude).map((i) => i.email.email)
          const otherIncludes = targetPolicy.include.filter((i) => !isEmailInclude(i))
          const union = Array.from(new Set([...currentEmails, ...emails]))
          const includeBody = [...otherIncludes, ...union.map((email) => ({ email: { email } }))]

          // 防御的ガード: includeBody が空になる場合(既存 allow ポリシーの include
          // も追加 emails も空)は PUT しない(空 include は CF 400)。実運用では
          // 既存 allow ポリシーの include が空になることは無いが、安全側に倒す。
          if (includeBody.length === 0) return

          yield* requestJson(
            HttpClientRequest.put(
              `${CF_API_BASE}/accounts/${accountId}/access/apps/${existingApp.id}/policies/${targetPolicy.id}`
            ).pipe(
              HttpClientRequest.bodyUnsafeJson({
                name: "inucon-team-members",
                decision: "allow",
                include: includeBody
              })
            )
          )
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
        const allDns = yield* request(
          HttpClientRequest.get(`${CF_API_BASE}/zones/${zoneId}/dns_records`).pipe(
            HttpClientRequest.setUrlParam("type", "CNAME"),
            HttpClientRequest.setUrlParam("per_page", "5000")
          ),
          DnsRecordsList
        )
        const ingress = yield* getIngress()
        const apps = yield* request(
          HttpClientRequest.get(`${CF_API_BASE}/accounts/${accountId}/access/apps`).pipe(
            HttpClientRequest.setUrlParam("per_page", "5000")
          ),
          AccessAppsList
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
        const managed = apps.filter((app) => MANAGED_HOSTNAME_PATTERN.test(app.domain.split(".")[0]))
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

