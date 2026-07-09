import { randomBytes } from "node:crypto"
import { HttpApiBuilder, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Config, Duration, Effect, Layer, Option } from "effect"
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

// リダイレクト + Set-Cookie は handleRaw で素の HttpServerResponse を返す
// (スパイク結果: ../README.md)。
export const AuthLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    // COOKIE_SECURE: 既定 true。ブラウザは http://localhost を secure context
    // 扱いするためローカル開発は既定値でも動くが、LAN の IP 直アクセス等の
    // 平文 HTTP で開発する場合のみ false にする(本番は必ず true のまま)。
    const cookieSecure = yield* Config.boolean("COOKIE_SECURE").pipe(Config.withDefault(true))
    // スペック §認証: 全 cookie 共通の属性。
    const secureCookie = { httpOnly: true, secure: cookieSecure, sameSite: "lax", path: "/" } as const

    return HttpApiBuilder.group(api, "auth", (handlers) =>
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
            // code / state はどちらも省略可能な契約になっているため、欠落も
            // ここでチェックする(欠落は state 不一致と同じ扱いにする)。
            const request = yield* HttpServerRequest.HttpServerRequest
            const stateCookie = request.cookies[STATE_COOKIE]
            const { code, state } = urlParams
            if (code === undefined || state === undefined || stateCookie === undefined || stateCookie !== state) {
              // state 不一致 / 欠落: 400 を返す(state cookie を破棄)。
              // ボディは契約(InvalidOAuthState)の encode と同形の JSON にする。
              const response = yield* HttpServerResponse.schemaJson(InvalidOAuthState)(
                new InvalidOAuthState(),
                { status: 400 }
              ).pipe(Effect.orDie)
              return yield* response.pipe(
                HttpServerResponse.setCookie(STATE_COOKIE, "", { ...secureCookie, maxAge: Duration.zero }),
                Effect.orDie
              )
            }

            const result = yield* handleOAuthCallback({ code }).pipe(
              Effect.catchTags({
                OAuthFailed: () => Effect.succeed(null),
                RepoError: (e) => Effect.die(e)
              })
            )

            if (result === null) {
              // トークン交換失敗: 502 を返す(state cookie を破棄)。
              // ボディは契約(OAuthExchangeFailed)の encode と同形の JSON にする。
              const response = yield* HttpServerResponse.schemaJson(OAuthExchangeFailed)(
                new OAuthExchangeFailed(),
                { status: 502 }
              ).pipe(Effect.orDie)
              return yield* response.pipe(
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
  })
)
