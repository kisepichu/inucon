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
    policies: Array<{ id: string; include: Array<{ email: { email: string } }> }>
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
      const matches = state.dnsRecords.filter((r) => r.name === name)
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
    const appDeleteMatch = path.match(/^\/client\/v4\/accounts\/acct-1\/access\/apps\/(.+)$/)
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
      const body = bodyJson(request) as { include: Array<{ email: { email: string } }> }
      const app = state.accessApps.find((a) => a.id === appId)
      const policy = { id: nextId(), include: body.include }
      if (app !== undefined) app.policies.push(policy)
      return Effect.succeed(jsonResponse(request, { success: true, result: policy }))
    }
    const policyUpdateMatch = path.match(
      /^\/client\/v4\/accounts\/acct-1\/access\/apps\/(.+)\/policies\/(.+)$/
    )
    if (policyUpdateMatch && method === "PUT") {
      const [, appId, policyId] = policyUpdateMatch
      const body = bodyJson(request) as { include: Array<{ email: { email: string } }> }
      const app = state.accessApps.find((a) => a.id === appId)
      const idx = app?.policies.findIndex((p) => p.id === policyId) ?? -1
      if (app !== undefined && idx >= 0) app.policies[idx] = { id: policyId, include: body.include }
      return Effect.succeed(jsonResponse(request, { success: true, result: { id: policyId, include: body.include } }))
    }

    return Effect.succeed(jsonResponse(request, { success: false, errors: [{ message: "not found" }] }, 404))
  })

  return { requests, state, layer: Layer.succeed(HttpClient.HttpClient, client) }
}

const portLayer = (fake: { layer: Layer.Layer<HttpClient.HttpClient> }) =>
  CloudflareLive.pipe(Layer.provide(fake.layer), Layer.provide(configLayer))

describe("ensureInstanceRoute", () => {
  it.effect("新規: DNS CNAME 作成 + tunnel ingress を catch-all の前に追加", () =>
    Effect.gen(function* () {
      const fake = makeFakeCf()
      yield* CloudflarePort.pipe(
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
})

describe("removeInstanceRoute", () => {
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

describe("ensureAccessApp", () => {
  it.effect("新規: Access アプリ + ポリシーを作成", () =>
    Effect.gen(function* () {
      const fake = makeFakeCf()
      yield* CloudflarePort.pipe(
        Effect.flatMap((cf) =>
          cf.ensureAccessApp({ hostname: "inucon-team1-1.kisen.one", emails: ["a@example.com", "b@example.com"] })
        ),
        Effect.provide(portLayer(fake))
      )

      expect(fake.state.accessApps).toHaveLength(1)
      const app = fake.state.accessApps[0]
      expect(app.domain).toBe("inucon-team1-1.kisen.one")
      expect(app.policies).toHaveLength(1)
      expect(app.policies[0].include.map((i) => i.email.email).sort()).toStrictEqual([
        "a@example.com",
        "b@example.com"
      ])
    })
  )

  it.effect("既存: 現行 include との和集合になる(既存メールを消さない)", () =>
    Effect.gen(function* () {
      const fake = makeFakeCf({
        accessApps: [
          {
            id: "app-1",
            domain: "inucon-team1-1.kisen.one",
            policies: [{ id: "pol-1", include: [{ email: { email: "existing@example.com" } }] }]
          }
        ]
      })
      yield* CloudflarePort.pipe(
        Effect.flatMap((cf) =>
          cf.ensureAccessApp({ hostname: "inucon-team1-1.kisen.one", emails: ["new@example.com"] })
        ),
        Effect.provide(portLayer(fake))
      )

      const app = fake.state.accessApps[0]
      expect(app.policies[0].include.map((i) => i.email.email).sort()).toStrictEqual([
        "existing@example.com",
        "new@example.com"
      ])
    })
  )

  it.effect("既存: 重複メールは 1 件に統合される", () =>
    Effect.gen(function* () {
      const fake = makeFakeCf({
        accessApps: [
          {
            id: "app-1",
            domain: "inucon-team1-1.kisen.one",
            policies: [{ id: "pol-1", include: [{ email: { email: "existing@example.com" } }] }]
          }
        ]
      })
      yield* CloudflarePort.pipe(
        Effect.flatMap((cf) =>
          cf.ensureAccessApp({ hostname: "inucon-team1-1.kisen.one", emails: ["existing@example.com"] })
        ),
        Effect.provide(portLayer(fake))
      )

      const app = fake.state.accessApps[0]
      expect(app.policies[0].include.map((i) => i.email.email)).toStrictEqual(["existing@example.com"])
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
})
