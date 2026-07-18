import { Clock, Effect } from "effect"
import { SESSION_COOKIE } from "shared"
import { SessionRepo, UserRepo } from "../../src/application/ports.js"
import { SESSION_TTL_MILLIS } from "../../src/application/usecases/auth.js"

// ログイン済み状態(users 行 + sessions 行)を直接作るテストヘルパー。
// 後続タスク(認可付きエンドポイントのテスト)でも使う。
// ttlMillis に負値を渡すと期限切れセッションを作れる。
export const login = (args?: {
  readonly githubId?: number
  readonly githubLogin?: string
  readonly displayName?: string
  readonly isAdmin?: boolean
  readonly ttlMillis?: number
}) =>
  Effect.gen(function* () {
    const users = yield* UserRepo
    const sessions = yield* SessionRepo
    const user = yield* users.upsertByGithub({
      githubId: args?.githubId ?? 1,
      githubLogin: args?.githubLogin ?? "test-user",
      displayName: args?.displayName ?? "Test User",
      isAdmin: args?.isAdmin ?? false
    })
    const now = yield* Clock.currentTimeMillis
    const sessionId = yield* sessions.create(user.id, now + (args?.ttlMillis ?? SESSION_TTL_MILLIS))
    return { user, sessionId, cookieHeader: `${SESSION_COOKIE}=${sessionId}` }
  })
