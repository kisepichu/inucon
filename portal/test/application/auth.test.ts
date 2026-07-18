import { it } from "@effect/vitest"
import { Effect, Exit, Layer, Option } from "effect"
import { describe, expect } from "vitest"
import { TeamId, UserId } from "../../src/domain/ids.js"
import { Team } from "../../src/domain/team.js"
import { AuthConfig, OAuthFailed, SessionRepo } from "../../src/application/ports.js"
import {
  getMe,
  handleOAuthCallback,
  logout,
  SESSION_TTL_MILLIS
} from "../../src/application/usecases/auth.js"
import { makeGithubOAuthStub } from "../support/githubOAuthStub.js"
import { makeAuthReposTest, makeInviteRepoTest, makeTeamRepoTest } from "../support/inMemory.js"

const stubCodes = {
  "code-taro": { githubId: 100, githubLogin: "taro", displayName: "Taro" },
  "code-admin": { githubId: 200, githubLogin: "admin-user", displayName: "Admin" }
}

const teamId = TeamId.make("team-1")
const memberId = UserId.make("member-1")
const team = new Team({ id: teamId, name: "team one", teamNumber: 1 })

const testLayer = Layer.mergeAll(
  makeAuthReposTest(),
  makeGithubOAuthStub(stubCodes),
  Layer.succeed(AuthConfig, { adminGithubLogins: ["admin-user"] }),
  makeTeamRepoTest({ teams: [team], memberships: [{ userId: memberId, teamId }] }),
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
