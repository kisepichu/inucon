import { createHash, timingSafeEqual } from "node:crypto"
import { Clock, Config, Effect, Layer, Option, Redacted } from "effect"
import type { Context } from "effect"
import type { ConfigError } from "effect/ConfigError"
import { AdminOnly, Authentication, Forbidden, RunnerAuth, Unauthorized } from "shared"
import { SessionRepo } from "../../application/ports.js"

// セッション cookie(HttpApiSecurity.apiKey in: "cookie")の値から CurrentUser
// を引く共通処理。cookie 欠落時は securityDecode が空文字の Redacted を渡して
// くるため、空文字も 401 にする。DB 障害(RepoError)は認証エラーではないので
// defect(500)へ。
const sessionUser = (sessions: Context.Tag.Service<SessionRepo>, token: Redacted.Redacted) =>
  Effect.gen(function* () {
    const sessionId = Redacted.value(token)
    if (sessionId === "") {
      return yield* Effect.fail(new Unauthorized())
    }
    const now = yield* Clock.currentTimeMillis
    const user = yield* sessions.findValidUser(sessionId, now).pipe(Effect.orDie)
    return yield* Option.match(user, {
      onNone: () => Effect.fail(new Unauthorized()),
      onSome: Effect.succeed
    })
  })

export const AuthenticationLive: Layer.Layer<Authentication, never, SessionRepo> = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const sessions = yield* SessionRepo
    return {
      session: (token) => sessionUser(sessions, token)
    }
  })
)

export const AdminOnlyLive: Layer.Layer<AdminOnly, never, SessionRepo> = Layer.effect(
  AdminOnly,
  Effect.gen(function* () {
    const sessions = yield* SessionRepo
    return {
      session: (token) =>
        sessionUser(sessions, token).pipe(
          Effect.filterOrFail((user) => user.isAdmin, () => new Forbidden())
        )
    }
  })
)

const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest()

export const RunnerAuthLive: Layer.Layer<RunnerAuth, ConfigError> = Layer.effect(
  RunnerAuth,
  Effect.gen(function* () {
    const token = yield* Config.redacted("RUNNER_TOKEN")
    const expected = sha256(Redacted.value(token))
    return {
      // 比較はタイミングセーフに行う。sha256 で長さを揃えることで
      // timingSafeEqual の長さ不一致例外(=長さ情報のリーク)も避ける。
      bearer: (bearer) =>
        timingSafeEqual(sha256(Redacted.value(bearer)), expected)
          ? Effect.void
          : Effect.fail(new Unauthorized())
    }
  })
)
