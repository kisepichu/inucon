import { createHash } from "node:crypto"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { describe, expect } from "vitest"
import { CloudflareError, CloudflarePort } from "../../src/application/ports.js"
import { CloudflareLive } from "../../src/infrastructure/cloudflare/client.js"

// CloudflareLive を、CF API v4 を模した fake HttpClient の上で検証する
// (githubOAuth.test.ts と同じパターン)。実 HTTP は発生しない。

const configLayer = Layer.setConfigProvider(
  ConfigProvider.fromMap(
    new Map([
      ["CF_API_TOKEN", "test-cf-token"],
      ["CF_ACCOUNT_ID", "acct-1"],
      ["CF_ZONE_ID", "zone-1"],
      ["CF_TUNNEL_ID", "0000aaaa-tunnel"]
    ])
  )
)

const jsonResponse = (request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  )

const bodyJson = (request: HttpClientRequest.HttpClientRequest): unknown => {
  if (request.body._tag !== "Uint8Array") return undefined
  return JSON.parse(new TextDecoder().decode(request.body.body))
}

interface FakeState {
  dnsRecords: Array<{ id: string; type: string; name: string; content: string; proxied: boolean }>
  ingress: Array<{ hostname?: string; service: string }>
  accessApps: Array<{
    id: string
    domain: string
    policies: Array<{ id: string; decision: string; include: Array<unknown> }>
  }>
}

const defaultIngress = () => [{ hostname: undefined, service: "http_status:404" }]

const makeFakeCf = (initial?: Partial<FakeState>) => {
  const state: FakeState = {
    dnsRecords: initial?.dnsRecords ?? [],
    ingress: initial?.ingress ?? defaultIngress(),
    accessApps: initial?.accessApps ?? []
  }
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  let idCounter = 0
  const nextId = () => `id-${++idCounter}`

  const client = HttpClient.make((request) => {
    requests.push(request)
    const url = HttpClientRequest.toUrl(request).pipe(
      (opt) => (opt._tag === "Some" ? opt.value : new URL(request.url))
    )
    const path = url.pathname
    const method = request.method

    // --- DNS records ---
    if (path === "/client/v4/zones/zone-1/dns_records" && method === "GET") {
      const name = url.searchParams.get("name")
      const matches = name === null
        ? state.dnsRecords
        : state.dnsRecords.filter((r) => r.name === name)
      return Effect.succeed(jsonResponse(request, { success: true, result: matches }))
    }
    if (path === "/client/v4/zones/zone-1/dns_records" && method === "POST") {
      const body = bodyJson(request) as { type: string; name: string; content: string; proxied: boolean }
      const record = { id: nextId(), ...body }
      state.dnsRecords.push(record)
      return Effect.succeed(jsonResponse(request, { success: true, result: record }))
    }
    const dnsRecordMatch = path.match(/^\/client\/v4\/zones\/zone-1\/dns_records\/(.+)$/)
    if (dnsRecordMatch && method === "PUT") {
      const id = dnsRecordMatch[1]
      const body = bodyJson(request) as { type: string; name: string; content: string; proxied: boolean }
      const idx = state.dnsRecords.findIndex((r) => r.id === id)
      if (idx >= 0) state.dnsRecords[idx] = { id, ...body }
      return Effect.succeed(jsonResponse(request, { success: true, result: { id, ...body } }))
    }
    if (dnsRecordMatch && method === "DELETE") {
      const id = dnsRecordMatch[1]
      state.dnsRecords = state.dnsRecords.filter((r) => r.id !== id)
      return Effect.succeed(jsonResponse(request, { success: true, result: { id } }))
    }

    // --- Tunnel configurations ---
    if (
      path === "/client/v4/accounts/acct-1/cfd_tunnel/0000aaaa-tunnel/configurations" &&
      method === "GET"
    ) {
      return Effect.succeed(
        jsonResponse(request, { success: true, result: { config: { ingress: state.ingress } } })
      )
    }
    if (
      path === "/client/v4/accounts/acct-1/cfd_tunnel/0000aaaa-tunnel/configurations" &&
      method === "PUT"
    ) {
      const body = bodyJson(request) as { config: { ingress: Array<{ hostname?: string; service: string }> } }
      state.ingress = body.config.ingress
      return Effect.succeed(
        jsonResponse(request, { success: true, result: { config: { ingress: state.ingress } } })
      )
    }

    // --- Access apps ---
    if (path === "/client/v4/accounts/acct-1/access/apps" && method === "GET") {
      return Effect.succeed(jsonResponse(request, { success: true, result: state.accessApps }))
    }
    if (path === "/client/v4/accounts/acct-1/access/apps" && method === "POST") {
      const body = bodyJson(request) as { domain: string }
      const app = { id: nextId(), domain: body.domain, policies: [] }
      state.accessApps.push(app)
      return Effect.succeed(jsonResponse(request, { success: true, result: app }))
    }
    // policies subresource は別 branch(下)で扱う。/apps/{id} 単体の DELETE
    // だけがここに落ちるよう `.+` から `[^/]+` に絞る。
    const appDeleteMatch = path.match(/^\/client\/v4\/accounts\/acct-1\/access\/apps\/([^/]+)$/)
    if (appDeleteMatch && method === "DELETE") {
      const id = appDeleteMatch[1]
      state.accessApps = state.accessApps.filter((a) => a.id !== id)
      return Effect.succeed(jsonResponse(request, { success: true, result: { id } }))
    }
    const policiesListMatch = path.match(/^\/client\/v4\/accounts\/acct-1\/access\/apps\/(.+)\/policies$/)
    if (policiesListMatch && method === "GET") {
      const appId = policiesListMatch[1]
      const app = state.accessApps.find((a) => a.id === appId)
      return Effect.succeed(jsonResponse(request, { success: true, result: app?.policies ?? [] }))
    }
    if (policiesListMatch && method === "POST") {
      const appId = policiesListMatch[1]
      const body = bodyJson(request) as { decision: string; include: Array<unknown> }
      const app = state.accessApps.find((a) => a.id === appId)
      const policy = { id: nextId(), decision: body.decision, include: body.include }
      if (app !== undefined) app.policies.push(policy)
      return Effect.succeed(jsonResponse(request, { success: true, result: policy }))
    }
    const policyUpdateMatch = path.match(
      /^\/client\/v4\/accounts\/acct-1\/access\/apps\/(.+)\/policies\/(.+)$/
    )
    if (policyUpdateMatch && method === "PUT") {
      const [, appId, policyId] = policyUpdateMatch
      const body = bodyJson(request) as { decision: string; include: Array<unknown> }
      const app = state.accessApps.find((a) => a.id === appId)
      const idx = app?.policies.findIndex((p) => p.id === policyId) ?? -1
      if (app !== undefined && idx >= 0) {
        app.policies[idx] = { id: policyId, decision: body.decision, include: body.include }
      }
      return Effect.succeed(
        jsonResponse(request, {
          success: true,
          result: { id: policyId, decision: body.decision, include: body.include }
        })
      )
    }
    if (policyUpdateMatch && method === "DELETE") {
      const [, appId, policyId] = policyUpdateMatch
      const app = state.accessApps.find((a) => a.id === appId)
      if (app !== undefined) {
        app.policies = app.policies.filter((p) => p.id !== policyId)
      }
      return Effect.succeed(jsonResponse(request, { success: true, result: { id: policyId } }))
    }

    return Effect.succeed(jsonResponse(request, { success: false, errors: [{ message: "not found" }] }, 404))
  })

  return { requests, state, layer: Layer.succeed(HttpClient.HttpClient, client) }
}

const portLayer = (fake: { layer: Layer.Layer<HttpClient.HttpClient> }) =>
  CloudflareLive.pipe(Layer.provide(fake.layer), Layer.provide(configLayer))

// テストの include アサーション用: include は Array<unknown> なので、
// email include だけを取り出して email 文字列に変換する小さなヘルパー。
const emailsOf = (include: ReadonlyArray<unknown>): Array<string> =>
  include
    .filter((i): i is { email: { email: string } } => {
      const e = i as { email?: { email?: unknown } }
      return typeof e?.email?.email === "string"
    })
    .map((i) => i.email.email)

// 記録済み request から pathname を取り出す(makeFakeCf 内のロジックと同じ)。
const pathOf = (request: HttpClientRequest.HttpClientRequest): string =>
  HttpClientRequest.toUrl(request).pipe((opt) => (opt._tag === "Some" ? opt.value : new URL(request.url))).pathname

// emails が空のときにポリシー POST/PUT が発生していないかを requests から確認する。
const policyWriteRequests = (requests: ReadonlyArray<HttpClientRequest.HttpClientRequest>) =>
  requests.filter(
    (r) => pathOf(r).includes("/policies") && (r.method === "POST" || r.method === "PUT")
  )

describe("ensureInstanceRoute", () => {
  it.effect("新規: DNS CNAME 作成 + tunnel ingress を catch-all の前に追加し、作成した record の id を返す", () =>
    Effect.gen(function* () {
      const fake = makeFakeCf()
      const returned = yield* CloudflarePort.pipe(
        Effect.flatMap((cf) => cf.ensureInstanceRoute({ hostname: "inucon-team1-1.kisen.one", ip: "10.100.1.11" })),
        Effect.provide(portLayer(fake))
      )

      expect(fake.state.dnsRecords).toHaveLength(1)
      expect(fake.state.dnsRecords[0]).toMatchObject({
        type: "CNAME",
        name: "inucon-team1-1.kisen.one",
        content: "0000aaaa-tunnel.cfargotunnel.com",
        proxied: true
      })

      expect(fake.state.ingress).toStrictEqual([
        { hostname: "inucon-team1-1.kisen.one", service: "ssh://10.100.1.11:22" },
        { service: "http_status:404" }
      ])
      // Task 9: portal は返り値の dnsRecordId を ResourceBinding.externalId に保存する。
      expect(returned.dnsRecordId).toBe(fake.state.dnsRecords[0].id)
    })
  )

  it.effect("既存 ingress を保持したまま追加(catch-all を消さない)", () =>
    Effect.gen(function* () {
      const fake = makeFakeCf({
        ingress: [
          { hostname: "inucon-team2-1.kisen.one", service: "ssh://10.100.2.11:22" },
          { hostname: undefined, service: "http_status:404" }
        ]
      })
      yield* CloudflarePort.pipe(
        Effect.flatMap((cf) => cf.ensureInstanceRoute({ hostname: "inucon-team1-1.kisen.one", ip: "10.100.1.11" })),
        Effect.provide(portLayer(fake))
      )

      expect(fake.state.ingress).toStrictEqual([
        { hostname: "inucon-team2-1.kisen.one", service: "ssh://10.100.2.11:22" },
        { hostname: "inucon-team1-1.kisen.one", service: "ssh://10.100.1.11:22" },
        { service: "http_status:404" }
      ])
    })
  )

  it.effect("冪等: 既存 DNS/ingress を置換する(重複を作らない)", () =>
    Effect.gen(function* () {
      const fake = makeFakeCf({
        dnsRecords: [
          {
            id: "existing-1",
            type: "CNAME",
            name: "inucon-team1-1.kisen.one",
            content: "0000aaaa-tunnel.cfargotunnel.com",
            proxied: true
          }
        ],
        ingress: [
          { hostname: "inucon-team1-1.kisen.one", service: "ssh://10.100.1.99:22" },
          { hostname: undefined, service: "http_status:404" }
        ]
      })
      yield* CloudflarePort.pipe(
        Effect.flatMap((cf) => cf.ensureInstanceRoute({ hostname: "inucon-team1-1.kisen.one", ip: "10.100.1.11" })),
        Effect.provide(portLayer(fake))
      )

      expect(fake.state.dnsRecords).toHaveLength(1)
      expect(fake.state.ingress).toStrictEqual([
        { hostname: "inucon-team1-1.kisen.one", service: "ssh://10.100.1.11:22" },
        { service: "http_status:404" }
      ])
    })
  )

  it.effect("Cloudflare API エラーは CloudflareError", () =>
    Effect.gen(function* () {
      const fake = makeFakeCf()
      const brokenClient = HttpClient.make((request) =>
        Effect.succeed(jsonResponse(request, { success: false, errors: [{ message: "boom" }] }, 500))
      )
      const brokenLayer = CloudflareLive.pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, brokenClient)),
        Layer.provide(configLayer)
      )
      const error = yield* CloudflarePort.pipe(
        Effect.flatMap((cf) => cf.ensureInstanceRoute({ hostname: "x.kisen.one", ip: "10.100.1.11" })),
        Effect.provide(brokenLayer),
        Effect.flip
      )
      expect(error).toBeInstanceOf(CloudflareError)
      void fake
    })
  )

  it.effect("HTTP は 2xx でもボディが success:false なら CloudflareError(errors の要約が cause に入り、トークンは含まない)", () =>
    Effect.gen(function* () {
      const fake = makeFakeCf()
      const rateLimitedClient = HttpClient.make((request) =>
        Effect.succeed(
          jsonResponse(request, {
            success: false,
            errors: [{ code: 1004, message: "DNS Validation Error" }],
            result: null
          })
        )
      )
      const rateLimitedLayer = CloudflareLive.pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, rateLimitedClient)),
        Layer.provide(configLayer)
      )
      const error = yield* CloudflarePort.pipe(
        Effect.flatMap((cf) => cf.ensureInstanceRoute({ hostname: "x.kisen.one", ip: "10.100.1.11" })),
        Effect.provide(rateLimitedLayer),
        Effect.flip
      )
      expect(error).toBeInstanceOf(CloudflareError)
      const cause = String((error as CloudflareError).cause)
      expect(cause).toContain("1004")
      expect(cause).toContain("DNS Validation Error")
      expect(cause).not.toContain("test-cf-token")
      void fake
    })
  )
})

describe("removeInstanceRoute", () => {
  it.effect("同一 hostname の CNAME が複数あると CloudflareError で失敗する", () =>
    Effect.gen(function* () {
      const fake = makeFakeCf({
        dnsRecords: [
          { id: "dup-1", type: "CNAME", name: "inucon-team1-1.kisen.one", content: "x.cfargotunnel.com", proxied: true },
          { id: "dup-2", type: "CNAME", name: "inucon-team1-1.kisen.one", content: "y.cfargotunnel.com", proxied: true }
        ]
      })
      const error = yield* CloudflarePort.pipe(
        Effect.flatMap((cf) => cf.ensureInstanceRoute({ hostname: "inucon-team1-1.kisen.one", ip: "10.100.1.11" })),
        Effect.provide(portLayer(fake)),
        Effect.flip
      )
      expect(error._tag).toBe("CloudflareError")
      if (error._tag === "CloudflareError") {
        expect(String(error.cause)).toContain("重複")
      }
    })
  )

  it.effect("DNS 削除 + ingress から該当ホストのみ除去(他は保持)", () =>
    Effect.gen(function* () {
      const fake = makeFakeCf({
        dnsRecords: [
          {
            id: "existing-1",
            type: "CNAME",
            name: "inucon-team1-1.kisen.one",
            content: "0000aaaa-tunnel.cfargotunnel.com",
            proxied: true
          }
        ],
        ingress: [
          { hostname: "inucon-team1-1.kisen.one", service: "ssh://10.100.1.11:22" },
          { hostname: "inucon-team2-1.kisen.one", service: "ssh://10.100.2.11:22" },
          { hostname: undefined, service: "http_status:404" }
        ]
      })
      yield* CloudflarePort.pipe(
        Effect.flatMap((cf) => cf.removeInstanceRoute("inucon-team1-1.kisen.one")),
        Effect.provide(portLayer(fake))
      )

      expect(fake.state.dnsRecords).toHaveLength(0)
      expect(fake.state.ingress).toStrictEqual([
        { hostname: "inucon-team2-1.kisen.one", service: "ssh://10.100.2.11:22" },
        { service: "http_status:404" }
      ])
    })
  )

  it.effect("冪等: 既に存在しない場合も成功する", () =>
    Effect.gen(function* () {
      const fake = makeFakeCf()
      yield* CloudflarePort.pipe(
        Effect.flatMap((cf) => cf.removeInstanceRoute("nope.kisen.one")),
        Effect.provide(portLayer(fake))
      )
      expect(fake.state.dnsRecords).toHaveLength(0)
    })
  )
})

describe("ensureAccessAppExact", () => {
  it.effect("新規: Access アプリ + ポリシーを作成し、正規化された include(sorted+lowercase+dedupe)を書き込む", () =>
    Effect.gen(function* () {
      const fake = makeFakeCf()
      const returned = yield* CloudflarePort.pipe(
        Effect.flatMap((cf) =>
          cf.ensureAccessAppExact({
            hostname: "inucon-team1-1.kisen.one",
            emails: [" B@Example.com ", "a@example.com", "A@example.com"]
          })
        ),
        Effect.provide(portLayer(fake))
      )

      expect(fake.state.accessApps).toHaveLength(1)
      const app = fake.state.accessApps[0]
      expect(app.domain).toBe("inucon-team1-1.kisen.one")
      expect(app.policies).toHaveLength(1)
      // 正規化: trim + lowercase + dedupe + sort。
      expect(emailsOf(app.policies[0].include)).toStrictEqual(["a@example.com", "b@example.com"])
      // 戻り値: appId + policyId を portal 側が ResourceBinding へ載せる。
      expect(returned.appId).toBe(app.id)
      expect(returned.policyId).toBe(app.policies[0].id)
    })
  )

  it.effect("既存: 過去エディションの email を保持しない(exact 上書き、union しない)", () =>
    Effect.gen(function* () {
      const fake = makeFakeCf({
        accessApps: [
          {
            id: "app-1",
            domain: "inucon-team1-1.kisen.one",
            policies: [
              {
                id: "pol-1",
                decision: "allow",
                include: [
                  { email: { email: "prior-edition-user@example.com" } },
                  { email: { email: "another-old@example.com" } }
                ]
              }
            ]
          }
        ]
      })
      yield* CloudflarePort.pipe(
        Effect.flatMap((cf) =>
          cf.ensureAccessAppExact({
            hostname: "inucon-team1-1.kisen.one",
            emails: ["new-edition@example.com"]
          })
        ),
        Effect.provide(portLayer(fake))
      )

      const app = fake.state.accessApps[0]
      // 過去エディションの 2 件は消える。exact = 新エディション 1 件のみ。
      expect(emailsOf(app.policies[0].include)).toStrictEqual(["new-edition@example.com"])
    })
  )

  it.effect("新規: emails 空はアプリだけ作りポリシーを作らない(policyId=null)", () =>
    Effect.gen(function* () {
      const fake = makeFakeCf()
      const returned = yield* CloudflarePort.pipe(
        Effect.flatMap((cf) => cf.ensureAccessAppExact({ hostname: "inucon-team1-1.kisen.one", emails: [] })),
        Effect.provide(portLayer(fake))
      )
      expect(fake.state.accessApps).toHaveLength(1)
      expect(fake.state.accessApps[0].policies).toHaveLength(0)
      expect(policyWriteRequests(fake.requests)).toHaveLength(0)
      expect(returned.policyId).toBeNull()
    })
  )

  it.effect("既存: emails 空は portal 所有 allow policy を削除して policyId=null を返す(deny-by-default)", () =>
    Effect.gen(function* () {
      const fake = makeFakeCf({
        accessApps: [
          {
            id: "app-1",
            domain: "inucon-team1-1.kisen.one",
            policies: [
              { id: "pol-1", decision: "allow", include: [{ email: { email: "member@example.com" } }] }
            ]
          }
        ]
      })
      const returned = yield* CloudflarePort.pipe(
        Effect.flatMap((cf) => cf.ensureAccessAppExact({ hostname: "inucon-team1-1.kisen.one", emails: [] })),
        Effect.provide(portLayer(fake))
      )
      expect(fake.state.accessApps[0].policies).toHaveLength(0)
      expect(returned.policyId).toBeNull()
    })
  )

  it.effect("既存: allow policy が 2 個以上あるとき AmbiguousAccessPolicy(multiple_allow_policies)で失敗する", () =>
    Effect.gen(function* () {
      const fake = makeFakeCf({
        accessApps: [
          {
            id: "app-1",
            domain: "inucon-team1-1.kisen.one",
            policies: [
              { id: "pol-a", decision: "allow", include: [{ email: { email: "a@example.com" } }] },
              { id: "pol-b", decision: "allow", include: [{ email: { email: "b@example.com" } }] }
            ]
          }
        ]
      })
      const error = yield* CloudflarePort.pipe(
        Effect.flatMap((cf) =>
          cf.ensureAccessAppExact({ hostname: "inucon-team1-1.kisen.one", emails: ["new@example.com"] })
        ),
        Effect.provide(portLayer(fake)),
        Effect.flip
      )
      expect(error._tag).toBe("AmbiguousAccessPolicy")
      if (error._tag === "AmbiguousAccessPolicy") {
        expect(error.hostname).toBe("inucon-team1-1.kisen.one")
        expect(error.reason).toBe("multiple_allow_policies")
      }
      // policy は書き換わっていない。
      expect(policyWriteRequests(fake.requests)).toHaveLength(0)
    })
  )

  it.effect("既存: allow policy の include に非 email(everyone/ip)が混ざっていると AmbiguousAccessPolicy(non_email_include_present)で失敗する", () =>
    Effect.gen(function* () {
      const fake = makeFakeCf({
        accessApps: [
          {
            id: "app-1",
            domain: "inucon-team1-1.kisen.one",
            policies: [
              {
                id: "pol-1",
                decision: "allow",
                include: [{ email: { email: "existing@example.com" } }, { everyone: {} }]
              }
            ]
          }
        ]
      })
      const error = yield* CloudflarePort.pipe(
        Effect.flatMap((cf) =>
          cf.ensureAccessAppExact({ hostname: "inucon-team1-1.kisen.one", emails: ["new@example.com"] })
        ),
        Effect.provide(portLayer(fake)),
        Effect.flip
      )
      expect(error._tag).toBe("AmbiguousAccessPolicy")
      if (error._tag === "AmbiguousAccessPolicy") {
        expect(error.reason).toBe("non_email_include_present")
      }
      expect(policyWriteRequests(fake.requests)).toHaveLength(0)
    })
  )

  it.effect("AmbiguousAccessPolicy 本体に生 email が載らない", () =>
    Effect.gen(function* () {
      const fake = makeFakeCf({
        accessApps: [
          {
            id: "app-1",
            domain: "inucon-team1-1.kisen.one",
            policies: [
              { id: "pol-a", decision: "allow", include: [{ email: { email: "secret-old@example.com" } }] },
              { id: "pol-b", decision: "allow", include: [{ email: { email: "another-secret@example.com" } }] }
            ]
          }
        ]
      })
      const error = yield* CloudflarePort.pipe(
        Effect.flatMap((cf) =>
          cf.ensureAccessAppExact({ hostname: "inucon-team1-1.kisen.one", emails: ["new@example.com"] })
        ),
        Effect.provide(portLayer(fake)),
        Effect.flip
      )
      const serialized = JSON.stringify(error)
      expect(serialized).not.toContain("secret-old")
      expect(serialized).not.toContain("another-secret")
      expect(serialized).not.toContain("new@example.com")
    })
  )
})

describe("removeAccessApp", () => {
  it.effect("該当アプリを削除する", () =>
    Effect.gen(function* () {
      const fake = makeFakeCf({
        accessApps: [{ id: "app-1", domain: "inucon-team1-1.kisen.one", policies: [] }]
      })
      yield* CloudflarePort.pipe(
        Effect.flatMap((cf) => cf.removeAccessApp("inucon-team1-1.kisen.one")),
        Effect.provide(portLayer(fake))
      )
      expect(fake.state.accessApps).toHaveLength(0)
    })
  )

  it.effect("冪等: 存在しなければ成功する", () =>
    Effect.gen(function* () {
      const fake = makeFakeCf()
      yield* CloudflarePort.pipe(
        Effect.flatMap((cf) => cf.removeAccessApp("nope.kisen.one")),
        Effect.provide(portLayer(fake))
      )
      expect(fake.state.accessApps).toHaveLength(0)
    })
  )

  it.effect("DELETE が 2xx + success:false を返すと CloudflareError(void 系ヘルパーの success 検証)", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) => {
        const url = HttpClientRequest.toUrl(request).pipe(
          (opt) => (opt._tag === "Some" ? opt.value : new URL(request.url))
        )
        if (url.pathname === "/client/v4/accounts/acct-1/access/apps" && request.method === "GET") {
          return Effect.succeed(
            jsonResponse(request, {
              success: true,
              result: [{ id: "app-1", domain: "inucon-team1-1.kisen.one" }]
            })
          )
        }
        return Effect.succeed(
          jsonResponse(request, { success: false, errors: [{ code: 7003, message: "Not authorized" }] })
        )
      })
      const layer = CloudflareLive.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)), Layer.provide(configLayer))
      const error = yield* CloudflarePort.pipe(
        Effect.flatMap((cf) => cf.removeAccessApp("inucon-team1-1.kisen.one")),
        Effect.provide(layer),
        Effect.flip
      )
      expect(error).toBeInstanceOf(CloudflareError)
      const cause = String((error as CloudflareError).cause)
      expect(cause).toContain("7003")
      expect(cause).toContain("Not authorized")
      expect(cause).not.toContain("test-cf-token")
    })
  )
})

// Task 7: reconciliation 向け inventory メソッド。DNS + tunnel ingress + Access
// app + policies を横断し、hostname prefix (inucon-team\d+-\d+) の resource
// だけを sanitized な形で返す。email 値は生では返さない(SHA-256 のみ)。
describe("getInstanceInventory", () => {
  it.effect("inucon-team* prefix の DNS / ingress / app / policy をまとめて返す。email は SHA-256 で返し、生の値は残さない", () =>
    Effect.gen(function* () {
      const fake = makeFakeCf({
        dnsRecords: [
          { id: "dns-1", type: "CNAME", name: "inucon-team1-1.kisen.one", content: "tunnel.cfargotunnel.com", proxied: true },
          { id: "dns-2", type: "CNAME", name: "inucon-team2-1.kisen.one", content: "tunnel.cfargotunnel.com", proxied: true },
          { id: "dns-x", type: "CNAME", name: "portal.kisen.one", content: "tunnel.cfargotunnel.com", proxied: true }
        ],
        ingress: [
          { hostname: "inucon-team1-1.kisen.one", service: "ssh://10.100.1.11:22" },
          { hostname: "inucon-team2-1.kisen.one", service: "ssh://10.100.2.11:22" },
          { hostname: "portal.kisen.one", service: "http://10.0.0.1:3000" },
          { hostname: undefined, service: "http_status:404" }
        ],
        accessApps: [
          {
            id: "app-1",
            domain: "inucon-team1-1.kisen.one",
            policies: [
              {
                id: "policy-1",
                decision: "allow",
                include: [
                  { email: { email: "Alice@Example.com" } },
                  { email: { email: "bob@example.com" } }
                ]
              }
            ]
          },
          {
            id: "app-2",
            domain: "inucon-team2-1.kisen.one",
            policies: [
              {
                id: "policy-2",
                decision: "allow",
                include: [
                  { email_domain: { domain: "example.com" } }
                ]
              }
            ]
          },
          {
            id: "app-portal",
            domain: "portal.kisen.one",
            policies: []
          }
        ]
      })
      const inventory = yield* CloudflarePort.pipe(
        Effect.flatMap((cf) => cf.getInstanceInventory),
        Effect.provide(portLayer(fake))
      )

      // portal.kisen.one / catch-all は絶対に含まれない
      expect(inventory.routes.map((r) => r.hostname).sort()).toEqual([
        "inucon-team1-1",
        "inucon-team2-1"
      ])
      expect(inventory.apps.map((a) => a.hostname).sort()).toEqual([
        "inucon-team1-1",
        "inucon-team2-1"
      ])

      const t1 = inventory.apps.find((a) => a.hostname === "inucon-team1-1")!
      expect(t1.policyShape).toBe("owned_exact")
      // email は生の値を含まず、sorted+normalized(小文字) の SHA-256 hex
      // top-level static import は import 群にまとめてある(createHash)。
      const expectedHash = createHash("sha256")
        .update("alice@example.com\nbob@example.com")
        .digest("hex")
      expect(t1.emailSetHash).toBe(expectedHash)

      const t2 = inventory.apps.find((a) => a.hostname === "inucon-team2-1")!
      // email_domain のみ → owned_exact ではない
      expect(t2.policyShape).toBe("unknown")

      // response 全体を JSON 化して生 email が含まれないことを確認
      const serialized = JSON.stringify(inventory)
      expect(serialized).not.toContain("alice")
      expect(serialized).not.toContain("Alice")
      expect(serialized).not.toContain("bob@")
    })
  )

  it.effect("DNS レコードが重複していれば dnsRecordIds に複数入り、planner が ambiguous を判定できる", () =>
    Effect.gen(function* () {
      const fake = makeFakeCf({
        dnsRecords: [
          { id: "dns-a", type: "CNAME", name: "inucon-team1-1.kisen.one", content: "tunnel.cfargotunnel.com", proxied: true },
          { id: "dns-b", type: "CNAME", name: "inucon-team1-1.kisen.one", content: "tunnel.cfargotunnel.com", proxied: true }
        ]
      })
      const inventory = yield* CloudflarePort.pipe(
        Effect.flatMap((cf) => cf.getInstanceInventory),
        Effect.provide(portLayer(fake))
      )
      const t1 = inventory.routes.find((r) => r.hostname === "inucon-team1-1")!
      expect(t1.dnsRecordIds.slice().sort()).toEqual(["dns-a", "dns-b"])
    })
  )
})
