import { HttpBody, HttpClient } from "@effect/platform"
import { it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { describe, expect } from "vitest"
import { TeamId } from "../../src/domain/ids.js"
import { DEFAULT_TEST_CONTEST_ID, makeTeam } from "../support/factories.js"
import { TeamRepo, UserRepo } from "../../src/application/ports.js"
import { login } from "../support/login.js"
import { TestLayer, asAdmin, seedOperationalContest } from "../support/apiTestHelpers.js"

describe("POST /api/admin/teams/:id/invites", () => {
  const post = (cookieHeader: string, teamId: string, payload: unknown) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return yield* client.post(`/api/admin/teams/${teamId}/invites`, {
        headers: { cookie: cookieHeader },
        body: HttpBody.unsafeJson(payload)
      })
    })

  it.effect("非 admin は403", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const teams = yield* TeamRepo
      const team = makeTeam({ id: TeamId.make("team-invite-403"), name: "Invite 403", teamNumber: 60 })
      yield* teams.create(team)

      const { cookieHeader } = yield* login({ isAdmin: false })
      const res = yield* post(cookieHeader, team.id, { githubLogin: "someone", email: "someone@example.com" })
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("cookie なしは401", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.post("/api/admin/teams/no-such-team/invites", {
        body: HttpBody.unsafeJson({ githubLogin: "someone", email: "someone@example.com" })
      })
      expect(res.status).toBe(401)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("存在しないチームは404", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const { cookieHeader } = yield* asAdmin()
      const res = yield* post(cookieHeader, "no-such-team", { githubLogin: "someone", email: "someone@example.com" })
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("既に他チームに所属するユーザーへの招待は409(横取りしない)", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const teams = yield* TeamRepo
      const teamA = makeTeam({ id: TeamId.make("team-invite-conflict-a"), name: "Invite Conflict A", teamNumber: 61 })
      const teamB = makeTeam({ id: TeamId.make("team-invite-conflict-b"), name: "Invite Conflict B", teamNumber: 62 })
      yield* teams.create(teamA)
      yield* teams.create(teamB)

      const { user } = yield* login({ githubLogin: "already-in-a" })
      yield* teams.setMembers(DEFAULT_TEST_CONTEST_ID, teamA.id, [user.id])

      const { cookieHeader } = yield* asAdmin()
      const res = yield* post(cookieHeader, teamB.id, { githubLogin: "already-in-a", email: "x@example.com" })
      expect(res.status).toBe(409)
      const body = yield* res.json
      expect(body).toStrictEqual({ _tag: "MemberConflict", logins: ["already-in-a"] })

      // 横取りされていない(teamA のメンバーのまま)。
      const stillInA = yield* teams.findByUserId(DEFAULT_TEST_CONTEST_ID, user.id)
      expect(stillInA).toStrictEqual(Option.some(teamA))
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("未ログインユーザーへの招待は200、portal=pendingでスキーマ通りの応答", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const teams = yield* TeamRepo
      const team = makeTeam({ id: TeamId.make("team-invite-pending"), name: "Invite Pending", teamNumber: 63 })
      yield* teams.create(team)

      const { cookieHeader } = yield* asAdmin()
      const res = yield* post(cookieHeader, team.id, { githubLogin: "not-yet-logged-in", email: "invitee@example.com" })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as {
        portal: string
        access: { ok: boolean; error?: string }
        sshKeys: ReadonlyArray<{ instance: string; ok: boolean; error?: string }>
        warnings: ReadonlyArray<string>
      }
      expect(body.portal).toBe("pending")
      expect(typeof body.access.ok).toBe("boolean")
      expect(body.sshKeys).toStrictEqual([])
      expect(body.warnings).toStrictEqual([])
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("既ログインユーザーへの招待は200、portal=assignedで即所属+email更新", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const teams = yield* TeamRepo
      const team = makeTeam({ id: TeamId.make("team-invite-assigned"), name: "Invite Assigned", teamNumber: 64 })
      yield* teams.create(team)

      const { user } = yield* login({ githubLogin: "already-registered" })

      const { cookieHeader } = yield* asAdmin()
      const res = yield* post(cookieHeader, team.id, { githubLogin: "already-registered", email: "reg@example.com" })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { portal: string }
      expect(body.portal).toBe("assigned")

      const assignedTeam = yield* teams.findByUserId(DEFAULT_TEST_CONTEST_ID, user.id)
      expect(assignedTeam).toStrictEqual(Option.some(team))

      const users = yield* UserRepo
      const updated = yield* users.findById(user.id)
      expect(Option.getOrNull(Option.flatMap(updated, (u) => u.email))).toBe("reg@example.com")
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("GET /api/admin/teams/:id/invites", () => {
  const get = (cookieHeader: string, teamId: string) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return yield* client.get(`/api/admin/teams/${teamId}/invites`, { headers: { cookie: cookieHeader } })
    })

  it.effect("非 admin は403", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const teams = yield* TeamRepo
      const team = makeTeam({ id: TeamId.make("team-invite-list-403"), name: "Invite List 403", teamNumber: 65 })
      yield* teams.create(team)

      const { cookieHeader } = yield* login({ isAdmin: false })
      const res = yield* get(cookieHeader, team.id)
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("存在しないチームは404", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const { cookieHeader } = yield* asAdmin()
      const res = yield* get(cookieHeader, "no-such-team")
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("招待中一覧が返る(消費済みは含まれない)", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const teams = yield* TeamRepo
      const team = makeTeam({ id: TeamId.make("team-invite-list-ok"), name: "Invite List OK", teamNumber: 66 })
      yield* teams.create(team)

      const { cookieHeader } = yield* asAdmin()
      const invitePost = (login: string) =>
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient
          return yield* client.post(`/api/admin/teams/${team.id}/invites`, {
            headers: { cookie: cookieHeader },
            body: HttpBody.unsafeJson({ githubLogin: login, email: `${login}@example.com` })
          })
        })

      // 1 人は未ログイン(pending のまま残る)、もう 1 人は既ログイン
      // (即所属し、team_invites には現れない)。
      yield* invitePost("still-pending")
      yield* login({ githubLogin: "already-assigned" })
      yield* invitePost("already-assigned")

      const res = yield* get(cookieHeader, team.id)
      expect(res.status).toBe(200)
      const body = (yield* res.json) as ReadonlyArray<{ githubLogin: string; email: string }>
      expect(body.map((i) => i.githubLogin)).toStrictEqual(["still-pending"])
      expect(body[0].email).toBe("still-pending@example.com")
    }).pipe(Effect.provide(TestLayer))
  )
})
