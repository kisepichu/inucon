import { Clock, Effect, Option } from "effect"
import type { UserId } from "../../domain/ids.js"
import type { Team } from "../../domain/team.js"
import type { User } from "../../domain/user.js"
import type { OAuthFailed, RepoError } from "../ports.js"
import { AuthConfig, GithubOAuthPort, InviteRepo, SessionRepo, TeamRepo, UserRepo } from "../ports.js"

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

    // 初ログイン時の team_invites 消費(スペック §招待フロー・Task 5):
    // 事前招待(未ログインユーザー宛)があれば、このログインで自動所属し、
    // Access ログイン用メール(users.email)を引き継ぎ、invite 行を削除する。
    // 冪等: 既にどこかのチームへ所属済みなら addMember はスキップし(横取り
    // 防止)、invite 行の消費(削除)だけ行う。addMember は TeamRepo.addMember
    // の原子的判定(TOCTOU 回避)により false(追加できなかった)を返し得るが、
    // その場合も同じユーザー・同じ invite の team_id で呼んでいるため既に
    // 目的のチームへ所属済みであり、以降の setEmail/delete のみで冪等に完了
    // する(結果は使わず捨ててよい)。
    const user = yield* consumeInviteOnFirstLogin(upserted)

    const sessions = yield* SessionRepo
    const now = yield* Clock.currentTimeMillis
    const sessionId = yield* sessions.create(user.id, now + SESSION_TTL_MILLIS)
    return { user, sessionId }
  })

// 初ログイン時の team_invites 消費(handleOAuthCallback から呼ぶ)。invite が
// 無ければ upsert 済みユーザーをそのまま返す。invite があれば所属 + email
// 反映後の最新ユーザーを findById で読み直して返す(setEmail は User を返さ
// ないため、レスポンスの email を正しくするには再取得する)。
const consumeInviteOnFirstLogin = (user: User): Effect.Effect<User, RepoError, UserRepo | TeamRepo | InviteRepo> =>
  Effect.gen(function* () {
    const invites = yield* InviteRepo
    const invite = yield* invites.findByGithubLogin(user.githubLogin)
    if (Option.isNone(invite)) return user

    const teams = yield* TeamRepo
    const currentTeam = yield* teams.findByUserId(user.id)
    if (Option.isNone(currentTeam)) {
      yield* teams.addMember(invite.value.teamId, user.id)
    }

    const users = yield* UserRepo
    yield* users.setEmail(user.id, invite.value.email)
    yield* invites.delete(user.githubLogin)

    return yield* users.findById(user.id).pipe(Effect.map(Option.getOrElse(() => user)))
  })

export const logout = (sessionId: string): Effect.Effect<void, RepoError, SessionRepo> =>
  SessionRepo.pipe(Effect.flatMap((sessions) => sessions.delete(sessionId)))

// GET /api/me のチーム部分。user 自体は Authentication ミドルウェアが提供する
// CurrentUser をそのまま返すため、ここではチームだけ引く。
export const getMe = (userId: UserId): Effect.Effect<Option.Option<Team>, RepoError, TeamRepo> =>
  TeamRepo.pipe(Effect.flatMap((teams) => teams.findByUserId(userId)))
