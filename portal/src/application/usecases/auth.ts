import { Clock, Effect, Option } from "effect"
import type { UserId } from "../../domain/ids.js"
import type { Team } from "../../domain/team.js"
import type { User } from "../../domain/user.js"
import type { OAuthFailed, RepoError } from "../ports.js"
import { AuthConfig, GithubOAuthPort, SessionRepo, TeamRepo, UserRepo } from "../ports.js"

// セッション有効期限: 30 日(スペック §認証)。
export const SESSION_TTL_MILLIS = 30 * 24 * 60 * 60 * 1000

// OAuth callback の後半: code 交換 → users upsert(isAdmin は
// ADMIN_GITHUB_LOGINS 由来)→ セッション発行。state 検証と cookie の
// 読み書きは HTTP 境界(handlers/auth.ts)の責務。
export const handleOAuthCallback = (args: {
  code: string
}): Effect.Effect<
  { user: User; sessionId: string },
  OAuthFailed | RepoError,
  GithubOAuthPort | UserRepo | SessionRepo | AuthConfig
> =>
  Effect.gen(function* () {
    const oauth = yield* GithubOAuthPort
    const gh = yield* oauth.exchangeCodeForUser(args.code)

    const config = yield* AuthConfig
    const users = yield* UserRepo
    const user = yield* users.upsertByGithub({
      githubId: gh.githubId,
      githubLogin: gh.githubLogin,
      displayName: gh.displayName,
      isAdmin: config.adminGithubLogins.includes(gh.githubLogin)
    })

    const sessions = yield* SessionRepo
    const now = yield* Clock.currentTimeMillis
    const sessionId = yield* sessions.create(user.id, now + SESSION_TTL_MILLIS)
    return { user, sessionId }
  })

export const logout = (sessionId: string): Effect.Effect<void, RepoError, SessionRepo> =>
  SessionRepo.pipe(Effect.flatMap((sessions) => sessions.delete(sessionId)))

// GET /api/me のチーム部分。user 自体は Authentication ミドルウェアが提供する
// CurrentUser をそのまま返すため、ここではチームだけ引く。
export const getMe = (userId: UserId): Effect.Effect<Option.Option<Team>, RepoError, TeamRepo> =>
  TeamRepo.pipe(Effect.flatMap((teams) => teams.findByUserId(userId)))
