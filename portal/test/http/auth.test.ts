import {
  Cookies,
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpClient
} from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Clock, ConfigProvider, Duration, Effect, Layer, Option, Schema } from "effect"
import { describe, expect } from "vitest"
import { AdminOnly, RunnerAuth, SESSION_COOKIE, STATE_COOKIE } from "shared"
import { TeamId } from "../../src/domain/ids.js"
import { Team } from "../../src/domain/team.js"
import { SessionRepo, TeamRepo } from "../../src/application/ports.js"
import { AdminOnlyLive, RunnerAuthLive } from "../../src/infrastructure/http/middleware.js"
import { login } from "../support/login.js"
import { makeAppTestLayer, ReposTestLive } from "../support/testApi.js"

const stubCodes = {
  "code-taro": { githubId: 100, githubLogin: "taro", displayName: "Taro" }
}

// 本物の api(shared)を、GithubOAuthPort だけスタブして起動する。
const TestLayer = makeAppTestLayer({ stubCodes, adminGithubLogins: ["admin-login"] })

const getCookie = (cookies: Cookies.Cookies, name: string) =>
  Option.getOrThrowWith(Cookies.get(cookies, name), () => new Error(`cookie ${name} not set`))

describe("GET /auth/github", () => {
  it.effect("302 で GitHub authorize へ。state cookie(HttpOnly/Secure/Lax/600s)が付く", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/auth/github")
      expect(res.status).toBe(302)

      const state = getCookie(res.cookies, STATE_COOKIE)
      expect(state.value).toMatch(/^[0-9a-f]{64}$/) // 32byte 乱数の hex
      expect(res.headers.location).toBe(
        `https://github.test/login/oauth/authorize?state=${state.value}`
      )
      expect(state.options?.httpOnly).toBe(true)
      expect(state.options?.secure).toBe(true)
      expect(state.options?.sameSite).toBe("lax")
      expect(state.options?.maxAge).toStrictEqual(Duration.seconds(600))
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("GET /auth/github/callback", () => {
  it.effect("正常系: users 行が作られ session cookie が設定され / へ 302", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/auth/github/callback?code=code-taro&state=st-1", {
        headers: { cookie: `${STATE_COOKIE}=st-1` }
      })
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/")

      const session = getCookie(res.cookies, SESSION_COOKIE)
      expect(session.value).not.toBe("")
      expect(session.options?.httpOnly).toBe(true)
      expect(session.options?.secure).toBe(true)
      expect(session.options?.sameSite).toBe("lax")
      expect(session.options?.maxAge).toStrictEqual(Duration.days(30))

      // state cookie は破棄される
      const state = getCookie(res.cookies, STATE_COOKIE)
      expect(state.value).toBe("")
      expect(state.options?.maxAge).toStrictEqual(Duration.zero)

      // users 行 + 有効なセッションが DB にある(findValidUser は users と JOIN)。
      // it.effect は TestClock(time=0)なので、現在時刻は Clock から取る。
      const now = yield* Clock.currentTimeMillis
      const sessions = yield* SessionRepo
      const user = yield* sessions.findValidUser(session.value, now)
      expect(Option.isSome(user)).toBe(true)
      if (Option.isSome(user)) {
        expect(user.value.githubLogin).toBe("taro")
        expect(user.value.githubId).toBe(100)
        expect(user.value.isAdmin).toBe(false)
      }
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("state 不一致は 400(state cookie も破棄される)", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/auth/github/callback?code=code-taro&state=evil", {
        headers: { cookie: `${STATE_COOKIE}=st-1` }
      })
      expect(res.status).toBe(400)

      // state cookie が破棄されることを確認
      const state = getCookie(res.cookies, STATE_COOKIE)
      expect(state.value).toBe("")
      expect(state.options?.maxAge).toStrictEqual(Duration.zero)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("state cookie 欠落は 400", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/auth/github/callback?code=code-taro&state=st-1")
      expect(res.status).toBe(400)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("code / state クエリ欠落は 400(Schema デコード失敗)", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/auth/github/callback", {
        headers: { cookie: `${STATE_COOKIE}=st-1` }
      })
      expect(res.status).toBe(400)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("コード交換に失敗したら 502(state cookie も破棄される)", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/auth/github/callback?code=unknown-code&state=st-1", {
        headers: { cookie: `${STATE_COOKIE}=st-1` }
      })
      expect(res.status).toBe(502)

      // state cookie が破棄されることを確認
      const state = getCookie(res.cookies, STATE_COOKIE)
      expect(state.value).toBe("")
      expect(state.options?.maxAge).toStrictEqual(Duration.zero)
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("GET /api/me", () => {
  it.effect("チーム所属ユーザーは user と team が返る", () =>
    Effect.gen(function* () {
      const { user, cookieHeader } = yield* login({ githubLogin: "taro-me", githubId: 300 })
      const teams = yield* TeamRepo
      const team = new Team({ id: TeamId.make("team-me"), name: "team me", teamNumber: 1 })
      yield* teams.create(team)
      yield* teams.setMembers(team.id, [user.id])

      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/me", { headers: { cookie: cookieHeader } })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { user: { githubLogin: string }; team: { name: string; teamNumber: number } | null }
      expect(body.user.githubLogin).toBe("taro-me")
      expect(body.team).toStrictEqual({ id: "team-me", name: "team me", teamNumber: 1 })
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("未所属ユーザーは team: null", () =>
    Effect.gen(function* () {
      const { cookieHeader } = yield* login()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/me", { headers: { cookie: cookieHeader } })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { team: unknown }
      expect(body.team).toBeNull()
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("期限切れセッションは 401", () =>
    Effect.gen(function* () {
      const { cookieHeader } = yield* login({ ttlMillis: -1000 })
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/me", { headers: { cookie: cookieHeader } })
      expect(res.status).toBe(401)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("cookie なしは 401", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/me")
      expect(res.status).toBe(401)
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("POST /api/auth/logout", () => {
  it.effect("204 でセッションが削除され cookie が破棄される", () =>
    Effect.gen(function* () {
      const { sessionId, cookieHeader } = yield* login()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.post("/api/auth/logout", { headers: { cookie: cookieHeader } })
      expect(res.status).toBe(204)

      const cleared = getCookie(res.cookies, SESSION_COOKIE)
      expect(cleared.value).toBe("")
      expect(cleared.options?.maxAge).toStrictEqual(Duration.zero)

      const sessions = yield* SessionRepo
      const after = yield* sessions.findValidUser(sessionId, 0)
      expect(after).toStrictEqual(Option.none())
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("セッションが無くても 204(冪等)", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.post("/api/auth/logout")
      expect(res.status).toBe(204)
    }).pipe(Effect.provide(TestLayer))
  )
})

// --- AdminOnly / RunnerAuth ---
// 実 API にはまだ admin / runner エンドポイントが無い(後続タスク)ため、
// テスト用の最小 HttpApi に本物のミドルウェア(Tag + Live Layer)を装着して
// 実挙動を検証する。

const secureApi = HttpApi.make("secureTest")
  .add(
    HttpApiGroup.make("admin").add(
      HttpApiEndpoint.get("ping", "/admin/ping")
        .addSuccess(Schema.Struct({ ok: Schema.Boolean }))
        .middleware(AdminOnly)
    )
  )
  .add(
    HttpApiGroup.make("runner").add(
      HttpApiEndpoint.get("ping", "/runner/ping")
        .addSuccess(Schema.Struct({ ok: Schema.Boolean }))
        .middleware(RunnerAuth)
    )
  )

const SecureApiLive = HttpApiBuilder.api(secureApi).pipe(
  Layer.provide(
    Layer.mergeAll(
      HttpApiBuilder.group(secureApi, "admin", (h) => h.handle("ping", () => Effect.succeed({ ok: true }))),
      HttpApiBuilder.group(secureApi, "runner", (h) => h.handle("ping", () => Effect.succeed({ ok: true })))
    )
  ),
  Layer.provide(AdminOnlyLive),
  Layer.provide(
    RunnerAuthLive.pipe(
      Layer.provide(
        Layer.setConfigProvider(ConfigProvider.fromMap(new Map([["RUNNER_TOKEN", "test-runner-token"]])))
      )
    )
  )
)

const SecureTestLayer = HttpApiBuilder.serve().pipe(
  Layer.provideMerge(SecureApiLive),
  Layer.provideMerge(ReposTestLive),
  Layer.provideMerge(NodeHttpServer.layerTest)
)

describe("AdminOnly", () => {
  it.effect("非 admin は 403", () =>
    Effect.gen(function* () {
      const { cookieHeader } = yield* login({ isAdmin: false })
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/admin/ping", { headers: { cookie: cookieHeader } })
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(SecureTestLayer))
  )

  it.effect("admin は 200", () =>
    Effect.gen(function* () {
      const { cookieHeader } = yield* login({ isAdmin: true })
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/admin/ping", { headers: { cookie: cookieHeader } })
      expect(res.status).toBe(200)
    }).pipe(Effect.provide(SecureTestLayer))
  )

  it.effect("未ログインは 401", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/admin/ping")
      expect(res.status).toBe(401)
    }).pipe(Effect.provide(SecureTestLayer))
  )
})

describe("RunnerAuth", () => {
  it.effect("bearer 不一致は 401", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/runner/ping", {
        headers: { authorization: "Bearer wrong-token" }
      })
      expect(res.status).toBe(401)
    }).pipe(Effect.provide(SecureTestLayer))
  )

  it.effect("Authorization ヘッダなしは 401", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/runner/ping")
      expect(res.status).toBe(401)
    }).pipe(Effect.provide(SecureTestLayer))
  )

  it.effect("正しい bearer は 200", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/runner/ping", {
        headers: { authorization: "Bearer test-runner-token" }
      })
      expect(res.status).toBe(200)
    }).pipe(Effect.provide(SecureTestLayer))
  )
})
