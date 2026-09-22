import { Clock, Effect, Option } from "effect"
import type { UserId } from "../../domain/ids.js"
import type { Team } from "../../domain/team.js"
import type { User } from "../../domain/user.js"
import type { OAuthFailed, RepoError } from "../ports.js"
import { AuthConfig, ContestRepo, GithubOAuthPort, InviteRepo, SessionRepo, TeamRepo, UserRepo } from "../ports.js"

// セッション有効期限: 30 日(スペック §認証)。
export const SESSION_TTL_MILLIS = 30 * 24 * 60 * 60 * 1000

// OAuth callback の後半: code 交換 → users upsert → 全 live contest 招待の
// 消費 → セッション発行。state 検証と cookie は HTTP 境界の責務。
export const handleOAuthCallback = (args: {
  code: string
}): Effect.Effect<
  { user: User; sessionId: string },
  OAuthFailed | RepoError,
  GithubOAuthPort | UserRepo | SessionRepo | TeamRepo | InviteRepo | AuthConfig
> =>
  Effect.gen(function* () {
    const oauth = yield* GithubOAuthPort
    const gh = yield* oauth.exchangeCodeForUser(args.code)

    const config = yield* AuthConfig
    const users = yield* UserRepo
    const upserted = yield* users.upsertByGithub({
      githubId: gh.githubId,
      githubLogin: gh.githubLogin,
      displayName: gh.displayName,
      isAdmin: config.adminGithubLogins.includes(gh.githubLogin)
    })

    const user = yield* consumeLiveInvitesOnLogin(upserted)

    const sessions = yield* SessionRepo
    const now = yield* Clock.currentTimeMillis
    const sessionId = yield* sessions.create(user.id, now + SESSION_TTL_MILLIS)
    return { user, sessionId }
  })

// Task 3 Step 5: 「全 live contest(draft/preparing/running/finalizing)に紐づく
// 招待をすべて消費する」。同じログインが第 n 回・第 n+1 回それぞれに事前招待
// されている場合、初ログインでどちらのチームにも所属させる(finished/canceled
// contest の招待残骸は無視)。email は最新の invite で上書きする(同一ログイン
// が異なるメールで招待されている場合の解決策は「最後に入った invite」に統一)。
const consumeLiveInvitesOnLogin = (user: User): Effect.Effect<User, RepoError, UserRepo | TeamRepo | InviteRepo> =>
  Effect.gen(function* () {
    const invites = yield* InviteRepo
    const pending = yield* invites.listByGithubLoginForLiveContests(user.githubLogin)
    if (pending.length === 0) return user

    const teams = yield* TeamRepo
    const users = yield* UserRepo

    let lastEmail: string | undefined
    for (const invite of pending) {
      const currentTeam = yield* teams.findByUserId(invite.contestId, user.id)
      if (Option.isNone(currentTeam)) {
        const added = yield* teams.addMember(invite.contestId, invite.teamId, user.id)
        // findByUserId=None なら add できる想定だが、scoped unique
        // (contest_id, user_id) 制約下で並行 admin 操作が同一 contest 内の
        // 別チームへ入れた場合のみ false になる。既に別チームに入っているの
        // なら invite は obsolete で delete するのが正しいが、post-mortem の
        // ため落ち先チームが invite と異なることを log で観測可能にしておく。
        if (!added) {
          const resolved = yield* teams.findByUserId(invite.contestId, user.id)
          if (Option.isSome(resolved) && resolved.value.id !== invite.teamId) {
            yield* Effect.logWarning(
              `consumeLiveInvitesOnLogin: race - user ${user.id} landed in team ${resolved.value.id} instead of invite target ${invite.teamId} for contest ${invite.contestId}`
            )
          }
        }
      }
      yield* invites.delete(invite.contestId, invite.githubLogin)
      lastEmail = invite.email
    }
    if (lastEmail !== undefined) {
      yield* users.setEmail(user.id, lastEmail)
    }
    return yield* users.findById(user.id).pipe(Effect.map(Option.getOrElse(() => user)))
  })

export const logout = (sessionId: string): Effect.Effect<void, RepoError, SessionRepo> =>
  SessionRepo.pipe(Effect.flatMap((sessions) => sessions.delete(sessionId)))

// GET /api/me のチーム部分。CurrentUser を持つ user は ContestRepo.getDisplay
// で解決した contest 内での所属チームを返す(0 contest の場合は None)。
export const getMe = (userId: UserId): Effect.Effect<Option.Option<Team>, RepoError, ContestRepo | TeamRepo> =>
  Effect.gen(function* () {
    const contests = yield* ContestRepo
    const contest = yield* contests.getDisplay
    if (Option.isNone(contest)) return Option.none()
    const teams = yield* TeamRepo
    return yield* teams.findByUserId(contest.value.id, userId)
  })
