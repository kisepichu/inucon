import { HttpClient, HttpClientResponse } from "@effect/platform"
import type { HttpClientRequest } from "@effect/platform"
import { it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { describe, expect } from "vitest"
import { GithubOAuthPort, OAuthFailed } from "../../src/application/ports.js"
import { GithubOAuthLive } from "../../src/infrastructure/github/oauth.js"

// GithubOAuthLive を、GitHub を模した fake HttpClient の上で検証する。
// 実 HTTP は発生しない(HttpClient.make によるトランスポート差し替え)。

const configLayer = Layer.setConfigProvider(
  ConfigProvider.fromMap(
    new Map([
      ["GITHUB_CLIENT_ID", "test-client-id"],
      ["GITHUB_CLIENT_SECRET", "test-client-secret"],
      ["BASE_URL", "https://inucon.example"]
    ])
  )
)

const jsonResponse = (request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    })
  )

const bodyText = (request: HttpClientRequest.HttpClientRequest): string =>
  request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : ""

// GitHub の 2 エンドポイントを模し、受け取ったリクエストを記録する fake。
const makeFakeGithub = (options?: { tokenBody?: unknown; userBody?: unknown }) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  const client = HttpClient.make((request) => {
    requests.push(request)
    if (request.url === "https://github.com/login/oauth/access_token") {
      return Effect.succeed(
        jsonResponse(request, options?.tokenBody ?? { access_token: "gho_test-token" })
      )
    }
    if (request.url === "https://api.github.com/user") {
      return Effect.succeed(
        jsonResponse(
          request,
          options?.userBody ?? { id: 12345, login: "octocat", name: "The Octocat" }
        )
      )
    }
    return Effect.succeed(jsonResponse(request, { message: "Not Found" }, 404))
  })
  return { requests, layer: Layer.succeed(HttpClient.HttpClient, client) }
}

const portLayer = (fake: { layer: Layer.Layer<HttpClient.HttpClient> }) =>
  GithubOAuthLive.pipe(Layer.provide(fake.layer), Layer.provide(configLayer))

describe("authorizeUrl", () => {
  it.effect("client_id / redirect_uri(BASE_URL 由来)/ state を含む GitHub authorize URL を返す", () =>
    Effect.gen(function* () {
      const oauth = yield* GithubOAuthPort
      const url = new URL(oauth.authorizeUrl("state-123"))
      expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize")
      expect(url.searchParams.get("client_id")).toBe("test-client-id")
      expect(url.searchParams.get("redirect_uri")).toBe(
        "https://inucon.example/auth/github/callback"
      )
      expect(url.searchParams.get("state")).toBe("state-123")
    }).pipe(Effect.provide(portLayer(makeFakeGithub())))
  )
})

describe("exchangeCodeForUser", () => {
  it.effect("token 交換 → /user 取得の 2 リクエストで GitHub ユーザーを返す", () =>
    Effect.gen(function* () {
      const fake = makeFakeGithub()
      const result = yield* GithubOAuthPort.pipe(
        Effect.flatMap((oauth) => oauth.exchangeCodeForUser("code-abc")),
        Effect.provide(portLayer(fake))
      )
      expect(result).toStrictEqual({
        githubId: 12345,
        githubLogin: "octocat",
        displayName: "The Octocat"
      })

      const [tokenReq, userReq] = fake.requests
      expect(tokenReq.method).toBe("POST")
      expect(tokenReq.headers.accept).toBe("application/json")
      const body = bodyText(tokenReq)
      expect(body).toContain("client_id=test-client-id")
      expect(body).toContain("client_secret=test-client-secret")
      expect(body).toContain("code=code-abc")

      expect(userReq.method).toBe("GET")
      expect(userReq.headers.authorization).toBe("Bearer gho_test-token")
      // GitHub API は User-Agent 必須
      expect(userReq.headers["user-agent"]).toBe("inucon-portal")
    })
  )

  it.effect("name が null のユーザーは login を displayName にする", () =>
    Effect.gen(function* () {
      const fake = makeFakeGithub({ userBody: { id: 1, login: "no-name", name: null } })
      const result = yield* GithubOAuthPort.pipe(
        Effect.flatMap((oauth) => oauth.exchangeCodeForUser("code-abc")),
        Effect.provide(portLayer(fake))
      )
      expect(result.displayName).toBe("no-name")
    })
  )

  it.effect("token レスポンスに access_token が無ければ OAuthFailed(GitHub は 200 + error body を返す)", () =>
    Effect.gen(function* () {
      const fake = makeFakeGithub({
        tokenBody: { error: "bad_verification_code", error_description: "..." }
      })
      const error = yield* GithubOAuthPort.pipe(
        Effect.flatMap((oauth) => oauth.exchangeCodeForUser("expired-code")),
        Effect.provide(portLayer(fake)),
        Effect.flip
      )
      expect(error).toBeInstanceOf(OAuthFailed)
    })
  )
})
