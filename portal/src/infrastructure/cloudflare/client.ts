import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { Config, Effect, Layer, Redacted, Schema } from "effect"
import type { ConfigError } from "effect/ConfigError"
import { CloudflareError, CloudflarePort } from "../../application/ports.js"
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
        })
    }
  })
)
