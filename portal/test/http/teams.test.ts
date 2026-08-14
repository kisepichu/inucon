import { HttpBody, HttpClient } from "@effect/platform"
import { it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { describe, expect } from "vitest"
import { TeamId } from "../../src/domain/ids.js"
import { TeamRepo } from "../../src/application/ports.js"
import { DEFAULT_TEST_CONTEST_ID, makeTeam } from "../support/factories.js"
import { login } from "../support/login.js"
import { TestLayer, asAdmin, seedOperationalContest } from "../support/apiTestHelpers.js"

describe("GET /api/teams", () => {
  it.effect("メンバーの githubLogin 込みでチーム一覧が返る", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const teams = yield* TeamRepo
      const team = makeTeam({ id: TeamId.make("team-list-1"), name: "Team List 1", teamNumber: 10 })
      yield* teams.create(team)
      const { user, cookieHeader } = yield* login({ githubLogin: "member-1" })
      yield* teams.setMembers(DEFAULT_TEST_CONTEST_ID, team.id, [user.id])

      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/teams", { headers: { cookie: cookieHeader } })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as ReadonlyArray<{ id: string; members: ReadonlyArray<{ githubLogin: string }> }>
      const found = body.find((t) => t.id === "team-list-1")
      expect(found?.members.map((m) => m.githubLogin)).toStrictEqual(["member-1"])
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("cookie なしは401", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/teams")
      expect(res.status).toBe(401)
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("POST /api/teams", () => {
  const post = (cookieHeader: string, payload: unknown) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return yield* client.post("/api/teams", {
        headers: { cookie: cookieHeader },
        body: HttpBody.unsafeJson(payload)
      })
    })

  it.effect("非 admin は403", () =>
    Effect.gen(function* () {
      const { cookieHeader } = yield* login({ isAdmin: false })
      const res = yield* post(cookieHeader, { name: "Team X", teamNumber: 20 })
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("admin は作成できる", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const { cookieHeader } = yield* asAdmin()
      const res = yield* post(cookieHeader, { name: "Team Y", teamNumber: 21 })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { name: string; teamNumber: number }
      expect(body.name).toBe("Team Y")
      expect(body.teamNumber).toBe(21)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("teamNumber 重複は409", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const { cookieHeader } = yield* asAdmin()
      const first = yield* post(cookieHeader, { name: "Team Dup 1", teamNumber: 22 })
      expect(first.status).toBe(200)

      const second = yield* post(cookieHeader, { name: "Team Dup 2", teamNumber: 22 })
      expect(second.status).toBe(409)
      const body = yield* second.json
      expect(body).toStrictEqual({ _tag: "TeamNumberConflict", teamNumber: 22 })
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("PUT /api/teams/:id/members", () => {
  const put = (cookieHeader: string, teamId: string, payload: unknown) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return yield* client.put(`/api/teams/${teamId}/members`, {
        headers: { cookie: cookieHeader },
        body: HttpBody.unsafeJson(payload)
      })
    })

  it.effect("非 admin は403", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const teams = yield* TeamRepo
      const team = makeTeam({ id: TeamId.make("team-members-403"), name: "Members 403", teamNumber: 30 })
      yield* teams.create(team)

      const { cookieHeader } = yield* login({ isAdmin: false })
      const res = yield* put(cookieHeader, team.id, { githubLogins: [] })
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("存在しないチームは404", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const { cookieHeader } = yield* asAdmin()
      const res = yield* put(cookieHeader, "no-such-team", { githubLogins: [] })
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("未ログイン(users に不在)の githubLogin は422で一覧が返る", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const teams = yield* TeamRepo
      const team = makeTeam({ id: TeamId.make("team-members-unknown"), name: "Members Unknown", teamNumber: 31 })
      yield* teams.create(team)

      const { cookieHeader } = yield* asAdmin()
      const res = yield* put(cookieHeader, team.id, { githubLogins: ["ghost-1", "ghost-2"] })
      expect(res.status).toBe(422)
      const body = yield* res.json
      expect(body).toStrictEqual({ _tag: "UnknownGithubLogins", logins: ["ghost-1", "ghost-2"] })
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("既に他チームに所属するユーザーが含まれる場合は409で衝突一覧が返る(横取りしない)", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const teams = yield* TeamRepo
      const teamA = makeTeam({ id: TeamId.make("team-members-conflict-a"), name: "Conflict A", teamNumber: 32 })
      const teamB = makeTeam({ id: TeamId.make("team-members-conflict-b"), name: "Conflict B", teamNumber: 33 })
      yield* teams.create(teamA)
      yield* teams.create(teamB)

      const { user: memberOfA } = yield* login({ githubLogin: "already-in-a" })
      yield* teams.setMembers(DEFAULT_TEST_CONTEST_ID, teamA.id, [memberOfA.id])

      const { cookieHeader } = yield* asAdmin()
      const res = yield* put(cookieHeader, teamB.id, { githubLogins: ["already-in-a"] })
      expect(res.status).toBe(409)
      const body = yield* res.json
      expect(body).toStrictEqual({ _tag: "MemberConflict", logins: ["already-in-a"] })

      const stillInA = yield* teams.findByUserId(DEFAULT_TEST_CONTEST_ID, memberOfA.id)
      expect(stillInA).toStrictEqual(Option.some(teamA))
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("ペイロード内の重複 login は1人として扱われる(500にならない)", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const teams = yield* TeamRepo
      const team = makeTeam({ id: TeamId.make("team-members-dup"), name: "Members Dup", teamNumber: 35 })
      yield* teams.create(team)

      const { user } = yield* login({ githubLogin: "member-dup" })

      const { cookieHeader } = yield* asAdmin()
      const res = yield* put(cookieHeader, team.id, { githubLogins: ["member-dup", "member-dup"] })
      expect(res.status).toBe(200)

      const members = yield* teams.listMembers(DEFAULT_TEST_CONTEST_ID, team.id)
      expect(members.map((m) => m.id)).toStrictEqual([user.id])
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("正常系: 全量置換され、更新後のメンバー一覧が返る", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const teams = yield* TeamRepo
      const team = makeTeam({ id: TeamId.make("team-members-ok"), name: "Members OK", teamNumber: 34 })
      yield* teams.create(team)

      const { user: memberA } = yield* login({ githubLogin: "member-ok-a", githubId: 1001 })
      const { user: memberB } = yield* login({ githubLogin: "member-ok-b", githubId: 1002 })

      const { cookieHeader } = yield* asAdmin()
      const res = yield* put(cookieHeader, team.id, { githubLogins: ["member-ok-a", "member-ok-b"] })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { members: ReadonlyArray<{ githubLogin: string }> }
      expect(body.members.map((m) => m.githubLogin).slice().sort()).toStrictEqual(["member-ok-a", "member-ok-b"])

      const members = yield* teams.listMembers(DEFAULT_TEST_CONTEST_ID, team.id)
      expect(members.map((m) => m.id).slice().sort()).toStrictEqual([memberA.id, memberB.id].slice().sort())
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("既存メンバーを含む同一チームへの再割当(冪等 PUT)はMemberConflictにならず成功する", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const teams = yield* TeamRepo
      const team = makeTeam({ id: TeamId.make("team-members-idempotent"), name: "Members Idempotent", teamNumber: 36 })
      yield* teams.create(team)

      const { user: memberA } = yield* login({ githubLogin: "idem-a", githubId: 1101 })
      const { user: memberB } = yield* login({ githubLogin: "idem-b", githubId: 1102 })
      yield* teams.setMembers(DEFAULT_TEST_CONTEST_ID, team.id, [memberA.id])

      const { cookieHeader } = yield* asAdmin()
      const res = yield* put(cookieHeader, team.id, { githubLogins: ["idem-a", "idem-b"] })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { members: ReadonlyArray<{ githubLogin: string }> }
      expect(body.members.map((m) => m.githubLogin).slice().sort()).toStrictEqual(["idem-a", "idem-b"])

      const members = yield* teams.listMembers(DEFAULT_TEST_CONTEST_ID, team.id)
      expect(members.map((m) => m.id).slice().sort()).toStrictEqual([memberA.id, memberB.id].slice().sort())
    }).pipe(Effect.provide(TestLayer))
  )
})
