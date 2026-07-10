import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { Config, Effect, Layer, Redacted, Schema } from "effect"
import type { ConfigError } from "effect/ConfigError"
import { CloudflareError, CloudflarePort } from "../../application/ports.js"

// Cloudflare API v4。Phase 1-2 は手動(ダッシュボード)で運用していた
// DNS CNAME / tunnel ingress / Access アプリの 3 操作を API 化する
// (スペック §アーキテクチャ、spike メモ §Step 6)。

const CF_API_BASE = "https://api.cloudflare.com/client/v4"

const DnsRecord = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  content: Schema.String
})

const DnsRecordsListResponse = Schema.Struct({
  result: Schema.Array(DnsRecord)
})

const IngressEntry = Schema.Struct({
  hostname: Schema.optional(Schema.String),
  service: Schema.String
})
type IngressEntry = typeof IngressEntry.Type

const TunnelConfigResponse = Schema.Struct({
  result: Schema.Struct({
    config: Schema.Struct({
      ingress: Schema.Array(IngressEntry)
    })
  })
})

const AccessApp = Schema.Struct({
  id: Schema.String,
  domain: Schema.String
})

const AccessAppsListResponse = Schema.Struct({
  result: Schema.Array(AccessApp)
})

const AccessAppResponse = Schema.Struct({
  result: AccessApp
})

const AccessPolicyInclude = Schema.Struct({
  email: Schema.Struct({ email: Schema.String })
})

const AccessPolicy = Schema.Struct({
  id: Schema.String,
  include: Schema.Array(AccessPolicyInclude)
})

const AccessPoliciesListResponse = Schema.Struct({
  result: Schema.Array(AccessPolicy)
})

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

    const request = <A>(
      req: HttpClientRequest.HttpClientRequest,
      schema: Schema.Schema<A, any>
    ): Effect.Effect<A, CloudflareError> =>
      client.execute(req).pipe(
        Effect.mapError((cause) => new CloudflareError({ cause })),
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? HttpClientResponse.schemaBodyJson(schema)(response).pipe(
                Effect.mapError((cause) => new CloudflareError({ cause }))
              )
            : Effect.fail(new CloudflareError({ cause: `Cloudflare API ${req.method} ${req.url} → ${response.status}` }))
        ),
        Effect.scoped
      )

    const requestJson = (
      req: HttpClientRequest.HttpClientRequest
    ): Effect.Effect<void, CloudflareError> =>
      client.execute(req).pipe(
        Effect.mapError((cause) => new CloudflareError({ cause })),
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? Effect.void
            : Effect.fail(new CloudflareError({ cause: `Cloudflare API ${req.method} ${req.url} → ${response.status}` }))
        ),
        Effect.scoped
      )

    const findDnsRecord = (hostname: string) =>
      request(
        HttpClientRequest.get(`${CF_API_BASE}/zones/${zoneId}/dns_records`).pipe(
          HttpClientRequest.setUrlParam("type", "CNAME"),
          HttpClientRequest.setUrlParam("name", hostname)
        ),
        DnsRecordsListResponse
      ).pipe(Effect.map((r) => r.result[0]))

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
        TunnelConfigResponse
      ).pipe(Effect.map((r) => r.result.config.ingress))

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
        AccessAppsListResponse
      ).pipe(Effect.map((r) => r.result.find((a) => a.domain === hostname)))

    const getPolicies = (appId: string) =>
      request(
        HttpClientRequest.get(`${CF_API_BASE}/accounts/${accountId}/access/apps/${appId}/policies`),
        AccessPoliciesListResponse
      ).pipe(Effect.map((r) => r.result))

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
              AccessAppResponse
            ).pipe(Effect.map((r) => r.result))
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
          const currentEmails = policies.flatMap((p) => p.include.map((i) => i.email.email))
          const union = Array.from(new Set([...currentEmails, ...emails]))
          const includeBody = union.map((email) => ({ email: { email } }))

          const existingPolicy = policies[0]
          if (existingPolicy === undefined) {
            yield* requestJson(
              HttpClientRequest.post(
                `${CF_API_BASE}/accounts/${accountId}/access/apps/${existingApp.id}/policies`
              ).pipe(
                HttpClientRequest.bodyUnsafeJson({
                  name: "inucon-team-members",
                  decision: "allow",
                  include: includeBody
                })
              )
            )
          } else {
            yield* requestJson(
              HttpClientRequest.put(
                `${CF_API_BASE}/accounts/${accountId}/access/apps/${existingApp.id}/policies/${existingPolicy.id}`
              ).pipe(
                HttpClientRequest.bodyUnsafeJson({
                  name: "inucon-team-members",
                  decision: "allow",
                  include: includeBody
                })
              )
            )
          }
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
