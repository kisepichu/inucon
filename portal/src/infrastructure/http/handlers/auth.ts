import { randomBytes } from "node:crypto"
import { HttpApiBuilder, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Duration, Effect, Option } from "effect"
import {
  api,
  CurrentUser,
  InvalidOAuthState,
  OAuthExchangeFailed,
  SESSION_COOKIE,
  STATE_COOKIE
} from "shared"
import { GithubOAuthPort } from "../../../application/ports.js"
import { getMe, handleOAuthCallback, logout, SESSION_TTL_MILLIS } from "../../../application/usecases/auth.js"

// スペック §認証: 全 cookie 共通の属性。
const secureCookie = { httpOnly: true, secure: true, sameSite: "lax", path: "/" } as const

// リダイレクト + Set-Cookie は handleRaw で素の HttpServerResponse を返す
// (スパイク結果: ../README.md)。
export const AuthLive = HttpApiBuilder.group(api, "auth", (handlers) =>
  handlers
    .handleRaw("githubLogin", () =>
      Effect.gen(function* () {
        const oauth = yield* GithubOAuthPort
        const state = randomBytes(32).toString("hex")
        return yield* HttpServerResponse.redirect(oauth.authorizeUrl(state), { status: 302 }).pipe(
          HttpServerResponse.setCookie(STATE_COOKIE, state, {
            ...secureCookie,
            maxAge: Duration.seconds(600)
          }),
          Effect.orDie
        )
      })
    )
    .handleRaw("githubCallback", ({ urlParams }) =>
      Effect.gen(function* () {
        // login CSRF 対策: state cookie と query の state の一致を必須にする。
        const request = yield* HttpServerRequest.HttpServerRequest
        const stateCookie = request.cookies[STATE_COOKIE]
        if (stateCookie === undefined || stateCookie !== urlParams.state) {
          // state 不一致: 400 を返す(state cookie を破棄)
          return yield* HttpServerResponse.empty({ status: 400 }).pipe(
            HttpServerResponse.setCookie(STATE_COOKIE, "", { ...secureCookie, maxAge: Duration.zero }),
            Effect.orDie
          )
        }

        const result = yield* handleOAuthCallback({ code: urlParams.code }).pipe(
          Effect.catchTags({
            OAuthFailed: () => Effect.succeed(null),
            RepoError: (e) => Effect.die(e)
          })
        )

        if (result === null) {
          // トークン交換失敗: 502 を返す(state cookie を破棄)
          return yield* HttpServerResponse.empty({ status: 502 }).pipe(
            HttpServerResponse.setCookie(STATE_COOKIE, "", { ...secureCookie, maxAge: Duration.zero }),
            Effect.orDie
          )
        }

        const { sessionId } = result

        return yield* HttpServerResponse.redirect("/", { status: 302 }).pipe(
          HttpServerResponse.setCookie(SESSION_COOKIE, sessionId, {
            ...secureCookie,
            maxAge: Duration.millis(SESSION_TTL_MILLIS)
          }),
          // 使い終わった state cookie は全パスで破棄する(成功時も失敗時も)。
          Effect.flatMap(
            HttpServerResponse.setCookie(STATE_COOKIE, "", { ...secureCookie, maxAge: Duration.zero })
          ),
          Effect.orDie
        )
      })
    )
    .handle("me", () =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const team = yield* getMe(user.id).pipe(Effect.orDie)
        return { user, team: Option.getOrNull(team) }
      })
    )
    .handleRaw("logout", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const sessionId = request.cookies[SESSION_COOKIE]
        if (sessionId !== undefined) {
          yield* logout(sessionId).pipe(Effect.orDie)
        }
        return yield* HttpServerResponse.empty({ status: 204 }).pipe(
          HttpServerResponse.setCookie(SESSION_COOKIE, "", { ...secureCookie, maxAge: Duration.zero }),
          Effect.orDie
        )
      })
    )
)
