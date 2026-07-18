import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { Config, Effect, Layer, Redacted, Schema } from "effect"
import type { ConfigError } from "effect/ConfigError"
import { GithubOAuthPort, OAuthFailed } from "../../application/ports.js"

// GitHub の token エンドポイントはエラー時も 200 で { error: ... } を返すため、
// access_token の有無は Schema デコードの成否で判定される(欠落 → OAuthFailed)。
const AccessTokenResponse = Schema.Struct({ access_token: Schema.String })

const GithubUser = Schema.Struct({
  id: Schema.Int,
  login: Schema.String,
  // name は未設定ユーザーで null になる。
  name: Schema.NullishOr(Schema.String)
})

export const GithubOAuthLive: Layer.Layer<GithubOAuthPort, ConfigError, HttpClient.HttpClient> =
  Layer.effect(
    GithubOAuthPort,
    Effect.gen(function* () {
      const clientId = yield* Config.redacted("GITHUB_CLIENT_ID")
      const clientSecret = yield* Config.redacted("GITHUB_CLIENT_SECRET")
      const baseUrl = yield* Config.string("BASE_URL")
      const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)

      return {
        authorizeUrl: (state) => {
          const params = new URLSearchParams({
            client_id: Redacted.value(clientId),
            redirect_uri: new URL("/auth/github/callback", baseUrl).toString(),
            state
          })
          return `https://github.com/login/oauth/authorize?${params.toString()}`
        },

        exchangeCodeForUser: (code) =>
          Effect.gen(function* () {
            const tokenRes = yield* HttpClientRequest.post(
              "https://github.com/login/oauth/access_token"
            ).pipe(
              HttpClientRequest.setHeader("accept", "application/json"),
              HttpClientRequest.bodyUrlParams({
                client_id: Redacted.value(clientId),
                client_secret: Redacted.value(clientSecret),
                code
              }),
              client.execute
            )
            const token = yield* HttpClientResponse.schemaBodyJson(AccessTokenResponse)(tokenRes)

            const userRes = yield* HttpClientRequest.get("https://api.github.com/user").pipe(
              HttpClientRequest.setHeaders({
                authorization: `Bearer ${token.access_token}`,
                accept: "application/vnd.github+json",
                // GitHub API は User-Agent 必須。
                "user-agent": "inucon-portal"
              }),
              client.execute
            )
            const gh = yield* HttpClientResponse.schemaBodyJson(GithubUser)(userRes)

            return {
              githubId: gh.id,
              githubLogin: gh.login,
              displayName: gh.name ?? gh.login
            }
          }).pipe(
            Effect.scoped,
            Effect.mapError((cause) => new OAuthFailed({ cause }))
          )
      }
    })
  )
