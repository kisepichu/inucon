import { it } from "@effect/vitest"
import { Effect, Exit, Layer, Option } from "effect"
import { describe, expect } from "vitest"
import { ContestId, TeamId, UserId } from "../../src/domain/ids.js"
import { AuthConfig, OAuthFailed, SessionRepo, TeamRepo, UserRepo } from "../../src/application/ports.js"
import {
  getMe,
  handleOAuthCallback,
  logout,
  SESSION_TTL_MILLIS
} from "../../src/application/usecases/auth.js"
import { DEFAULT_TEST_CONTEST_ID, makeContest, makeInvite, makeTeam } from "../support/factories.js"
import { makeGithubOAuthStub } from "../support/githubOAuthStub.js"
import {
  makeAuthReposTest,
  makeContestRepoTest,
  makeInviteRepoTest,
  makeInviteReposTest,
  makeTeamRepoTest
} from "../support/inMemory.js"

const stubCodes = {
  "code-taro": { githubId: 100, githubLogin: "taro", displayName: "Taro" },
  "code-admin": { githubId: 200, githubLogin: "admin-user", displayName: "Admin" }
}

const teamId = TeamId.make("team-1")
const memberId = UserId.make("member-1")
// Task 3: getMe / auth は ContestRepo.getDisplay を経由するため、running な
// contest を用意する(display は running を最優先で返す)。
const contest = makeContest({ id: DEFAULT_TEST_CONTEST_ID, status: "running" })
const team = makeTeam({ id: teamId, name: "team one", teamNumber: 1 })

const testLayer = Layer.mergeAll(
  makeAuthReposTest(),
  makeGithubOAuthStub(stubCodes),
  Layer.succeed(AuthConfig, { adminGithubLogins: ["admin-user"] }),
  makeContestRepoTest([contest]),
  makeTeamRepoTest({
    teams: [team],
    memberships: [{ contestId: DEFAULT_TEST_CONTEST_ID, userId: memberId, teamId }]
  }),
  makeInviteRepoTest([])
)

describe("handleOAuthCallback", () => {
  it.effect("正常系: user が upsert され 30 日有効なセッションが作られる", () =>
    Effect.gen(function* () {
      // it.effect の TestClock は time=0 始まり → expiresAt = SESSION_TTL_MILLIS。
      const { sessionId, user } = yield* handleOAuthCallback({ code: "code-taro" })
      expect(user.githubLogin).toBe("taro")
      expect(user.displayName).toBe("Taro")
      expect(user.isAdmin).toBe(false)

      const sessions = yield* SessionRepo
      const justBeforeExpiry = yield* sessions.findValidUser(sessionId, SESSION_TTL_MILLIS - 1)
      expect(Option.isSome(justBeforeExpiry)).toBe(true)
      if (Option.isSome(justBeforeExpiry)) {
        expect(justBeforeExpiry.value.githubId).toBe(100)
      }
      const atExpiry = yield* sessions.findValidUser(sessionId, SESSION_TTL_MILLIS)
      expect(atExpiry).toStrictEqual(Option.none())
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("ADMIN_GITHUB_LOGINS に載っている login は isAdmin=true になる", () =>
    Effect.gen(function* () {
      const { user } = yield* handleOAuthCallback({ code: "code-admin" })
      expect(user.githubLogin).toBe("admin-user")
      expect(user.isAdmin).toBe(true)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("コード交換に失敗したら OAuthFailed", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(handleOAuthCallback({ code: "bad-code" }))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.toString()).toContain("OAuthFailed")
      }
      // 失敗を型どおり検証(値の等価比較は cause フィールドが自由形式なので避ける)
      const error = yield* handleOAuthCallback({ code: "bad-code" }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(OAuthFailed)
    }).pipe(Effect.provide(testLayer))
  )
})

describe("logout", () => {
  it.effect("セッションが削除され findValidUser が None になる", () =>
    Effect.gen(function* () {
      const { sessionId } = yield* handleOAuthCallback({ code: "code-taro" })
      const sessions = yield* SessionRepo
      const before = yield* sessions.findValidUser(sessionId, 0)
      expect(Option.isSome(before)).toBe(true)

      yield* logout(sessionId)

      const after = yield* sessions.findValidUser(sessionId, 0)
      expect(after).toStrictEqual(Option.none())
    }).pipe(Effect.provide(testLayer))
  )
})

describe("getMe", () => {
  it.effect("チーム所属ユーザーは Some(team) が返る", () =>
    Effect.gen(function* () {
      const result = yield* getMe(memberId)
      expect(result).toStrictEqual(Option.some(team))
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("未所属ユーザーは None が返る", () =>
    Effect.gen(function* () {
      const result = yield* getMe(UserId.make("no-team-user"))
      expect(result).toStrictEqual(Option.none())
    }).pipe(Effect.provide(testLayer))
  )
})

// Task 3 Step 5: 初ログイン時に「複数 live contest の全 invite を消費」する
// 契約の regression。SQL レイヤの ORDER BY invited_at ASC + auth の for-of
// 「最後の email が users.email を上書き」が組み合わさって決定論になる。
describe("handleOAuthCallback: multi-contest invite consumption", () => {
  const contestAId = ContestId.make("00000000-0000-0000-0000-cccccccdaaa1")
  const contestBId = ContestId.make("00000000-0000-0000-0000-cccccccdaaa2")
  const teamAId = TeamId.make("team-multi-a")
  const teamBId = TeamId.make("team-multi-b")
  const teamA = makeTeam({ id: teamAId, contestId: contestAId, name: "MultiTeamA", teamNumber: 11 })
  const teamB = makeTeam({ id: teamBId, contestId: contestBId, name: "MultiTeamB", teamNumber: 12 })

  const inviteA = makeInvite({
    contestId: contestAId,
    teamId: teamAId,
    githubLogin: "taro",
    email: "taro-a@example.com",
    invitedAt: 1000
  })
  const inviteB = makeInvite({
    contestId: contestBId,
    teamId: teamBId,
    githubLogin: "taro",
    email: "taro-b@example.com",
    invitedAt: 2000
  })

  // makeInviteReposTest は UserRepo/SessionRepo/TeamRepo/InviteRepo を単一 Ref で
  // 共有する。contests を渡すと listByGithubLoginForLiveContests が
  // draft/preparing/running/finalizing のみに絞る (SQL 実装と同じ契約)。
  const multiLayer = Layer.mergeAll(
    makeInviteReposTest({
      teams: [teamA, teamB],
      contests: [
        makeContest({ id: contestAId, edition: 91, status: "running" }),
        makeContest({ id: contestBId, edition: 92, status: "draft" })
      ],
      invites: [inviteA, inviteB]
    }),
    makeGithubOAuthStub(stubCodes),
    Layer.succeed(AuthConfig, { adminGithubLogins: [] })
  )

  it.effect("2 live contest の invite が両方消費され、user.email は invitedAt が新しい方の invite で上書きされる", () =>
    Effect.gen(function* () {
      const { user } = yield* handleOAuthCallback({ code: "code-taro" })

      // 1. 両 contest の team に所属している (findByUserId が contest 別に解決)。
      const teams = yield* TeamRepo
      const inA = yield* teams.findByUserId(contestAId, user.id)
      const inB = yield* teams.findByUserId(contestBId, user.id)
      expect(Option.map(inA, (t) => t.id)).toStrictEqual(Option.some(teamAId))
      expect(Option.map(inB, (t) => t.id)).toStrictEqual(Option.some(teamBId))

      // 2. users.email は invitedAt=2000 の inviteB (=最後にループで見た invite) で決まる。
      //    SQL 側の ORDER BY invited_at ASC と for-of ループの「最後が勝つ」が
      //    連携することで決定論的に taro-b になる。
      const users = yield* UserRepo
      const found = yield* users.findById(user.id)
      expect(Option.isSome(found)).toBe(true)
      if (Option.isSome(found)) {
        expect(Option.getOrElse(found.value.email, () => "")).toBe("taro-b@example.com")
      }
    }).pipe(Effect.provide(multiLayer))
  )
})
