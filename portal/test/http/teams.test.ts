import { HttpApiClient, HttpBody, HttpClient, HttpClientRequest } from "@effect/platform"
import { it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { describe, expect } from "vitest"
import { api, DuplicateInstanceIndex } from "shared"
import { Contest } from "../../src/domain/contest.js"
import { Instance } from "../../src/domain/instance.js"
import { ContestId, InstanceId, TeamId } from "../../src/domain/ids.js"
import { Team } from "../../src/domain/team.js"
import { ContestRepo, InstanceRepo, TeamRepo } from "../../src/application/ports.js"
import { login } from "../support/login.js"
import { makeAppTestLayer } from "../support/testApi.js"

// 本物の api(shared)を、AdminOnly/Authentication ともに本物の Live を通して
// 起動する(test/http/auth.test.ts の TestLayer と同じ形)。admin-login が
// ADMIN_GITHUB_LOGINS 相当。
const TestLayer = makeAppTestLayer({ adminGithubLogins: ["admin-login"] })

const asAdmin = () => login({ githubLogin: "admin-login", githubId: 900, isAdmin: true })

// cookie ヘッダは HttpApiClient の request 引数に無いため transformClient で
// 注入する(test/http/auth.test.ts の makeApiClient と同じ形)。
const makeApiClient = (cookieHeader: string) =>
  HttpApiClient.make(api, {
    transformClient: (client) => HttpClient.mapRequest(client, HttpClientRequest.setHeader("cookie", cookieHeader))
  })

describe("GET /api/contest", () => {
  it.effect("コンテスト未作成は404", () =>
    Effect.gen(function* () {
      const { cookieHeader } = yield* login()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/contest", { headers: { cookie: cookieHeader } })
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("cookie なしは401", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/contest")
      expect(res.status).toBe(401)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("作成済みなら200でコンテスト情報が返る", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.save(
        new Contest({ id: ContestId.make("contest-1"), name: "INUCON", problemKey: "private-isu", status: "preparing" })
      )

      const { cookieHeader } = yield* login()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/contest", { headers: { cookie: cookieHeader } })
      expect(res.status).toBe(200)
      const body = yield* res.json
      expect(body).toStrictEqual({ id: "contest-1", name: "INUCON", problemKey: "private-isu", status: "preparing" })
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("GET /api/teams", () => {
  it.effect("メンバーの githubLogin 込みでチーム一覧が返る", () =>
    Effect.gen(function* () {
      const teams = yield* TeamRepo
      const team = new Team({ id: TeamId.make("team-list-1"), name: "Team List 1", teamNumber: 10 })
      yield* teams.create(team)
      const { user, cookieHeader } = yield* login({ githubLogin: "member-1" })
      yield* teams.setMembers(team.id, [user.id])

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
      const teams = yield* TeamRepo
      const team = new Team({ id: TeamId.make("team-members-403"), name: "Members 403", teamNumber: 30 })
      yield* teams.create(team)

      const { cookieHeader } = yield* login({ isAdmin: false })
      const res = yield* put(cookieHeader, team.id, { githubLogins: [] })
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("存在しないチームは404", () =>
    Effect.gen(function* () {
      const { cookieHeader } = yield* asAdmin()
      const res = yield* put(cookieHeader, "no-such-team", { githubLogins: [] })
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("未ログイン(users に不在)の githubLogin は422で一覧が返る", () =>
    Effect.gen(function* () {
      const teams = yield* TeamRepo
      const team = new Team({ id: TeamId.make("team-members-unknown"), name: "Members Unknown", teamNumber: 31 })
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
      const teams = yield* TeamRepo
      const teamA = new Team({ id: TeamId.make("team-members-conflict-a"), name: "Conflict A", teamNumber: 32 })
      const teamB = new Team({ id: TeamId.make("team-members-conflict-b"), name: "Conflict B", teamNumber: 33 })
      yield* teams.create(teamA)
      yield* teams.create(teamB)

      const { user: memberOfA } = yield* login({ githubLogin: "already-in-a" })
      yield* teams.setMembers(teamA.id, [memberOfA.id])

      const { cookieHeader } = yield* asAdmin()
      const res = yield* put(cookieHeader, teamB.id, { githubLogins: ["already-in-a"] })
      expect(res.status).toBe(409)
      const body = yield* res.json
      expect(body).toStrictEqual({ _tag: "MemberConflict", logins: ["already-in-a"] })

      // 横取りされていない(teamA のメンバーのまま)ことを確認
      const stillInA = yield* teams.findByUserId(memberOfA.id)
      expect(stillInA).toStrictEqual(Option.some(teamA))
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("ペイロード内の重複 login は1人として扱われる(500にならない)", () =>
    Effect.gen(function* () {
      const teams = yield* TeamRepo
      const team = new Team({ id: TeamId.make("team-members-dup"), name: "Members Dup", teamNumber: 35 })
      yield* teams.create(team)

      const { user } = yield* login({ githubLogin: "member-dup" })

      const { cookieHeader } = yield* asAdmin()
      const res = yield* put(cookieHeader, team.id, { githubLogins: ["member-dup", "member-dup"] })
      expect(res.status).toBe(200)

      const members = yield* teams.listMembers(team.id)
      expect(members.map((m) => m.id)).toStrictEqual([user.id])
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("正常系: 全量置換され、更新後のメンバー一覧が返る", () =>
    Effect.gen(function* () {
      const teams = yield* TeamRepo
      const team = new Team({ id: TeamId.make("team-members-ok"), name: "Members OK", teamNumber: 34 })
      yield* teams.create(team)

      const { user: memberA } = yield* login({ githubLogin: "member-ok-a", githubId: 1001 })
      const { user: memberB } = yield* login({ githubLogin: "member-ok-b", githubId: 1002 })

      const { cookieHeader } = yield* asAdmin()
      const res = yield* put(cookieHeader, team.id, { githubLogins: ["member-ok-a", "member-ok-b"] })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { members: ReadonlyArray<{ githubLogin: string }> }
      expect(body.members.map((m) => m.githubLogin).slice().sort()).toStrictEqual(["member-ok-a", "member-ok-b"])

      const members = yield* teams.listMembers(team.id)
      expect(members.map((m) => m.id).slice().sort()).toStrictEqual([memberA.id, memberB.id].slice().sort())
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("既存メンバーを含む同一チームへの再割当(冪等 PUT)はMemberConflictにならず成功する", () =>
    Effect.gen(function* () {
      const teams = yield* TeamRepo
      const team = new Team({ id: TeamId.make("team-members-idempotent"), name: "Members Idempotent", teamNumber: 36 })
      yield* teams.create(team)

      const { user: memberA } = yield* login({ githubLogin: "idem-a", githubId: 1101 })
      const { user: memberB } = yield* login({ githubLogin: "idem-b", githubId: 1102 })
      yield* teams.setMembers(team.id, [memberA.id])

      const { cookieHeader } = yield* asAdmin()
      // memberA は既に team のメンバー。setTeamMembers の
      // findByUserId(memberA.id) === team.id となるため、既存メンバーを含む
      // 再割当(memberB を追加)が MemberConflict(横取り判定)にならないことを
      // 確認する。
      const res = yield* put(cookieHeader, team.id, { githubLogins: ["idem-a", "idem-b"] })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { members: ReadonlyArray<{ githubLogin: string }> }
      expect(body.members.map((m) => m.githubLogin).slice().sort()).toStrictEqual(["idem-a", "idem-b"])

      const members = yield* teams.listMembers(team.id)
      expect(members.map((m) => m.id).slice().sort()).toStrictEqual([memberA.id, memberB.id].slice().sort())
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("GET /api/teams/:id/instances", () => {
  it.effect("自チームのメンバーは200", () =>
    Effect.gen(function* () {
      const teams = yield* TeamRepo
      const instances = yield* InstanceRepo
      const team = new Team({ id: TeamId.make("team-inst-self"), name: "Inst Self", teamNumber: 40 })
      yield* teams.create(team)
      const instance = new Instance({
        id: InstanceId.make("inst-self-1"),
        teamId: team.id,
        index: 1,
        privateIp: "10.100.40.10",
        status: "active"
      })
      yield* instances.create(instance)

      const { user, cookieHeader } = yield* login({ githubLogin: "inst-self-member" })
      yield* teams.setMembers(team.id, [user.id])

      const client = yield* HttpClient.HttpClient
      const res = yield* client.get(`/api/teams/${team.id}/instances`, { headers: { cookie: cookieHeader } })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as ReadonlyArray<{ id: string }>
      expect(body.map((i) => i.id)).toStrictEqual(["inst-self-1"])
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("他チームのメンバー(非 admin)は403", () =>
    Effect.gen(function* () {
      const teams = yield* TeamRepo
      const teamA = new Team({ id: TeamId.make("team-inst-other-a"), name: "Inst Other A", teamNumber: 41 })
      const teamB = new Team({ id: TeamId.make("team-inst-other-b"), name: "Inst Other B", teamNumber: 42 })
      yield* teams.create(teamA)
      yield* teams.create(teamB)

      const { user, cookieHeader } = yield* login({ githubLogin: "inst-other-member" })
      yield* teams.setMembers(teamB.id, [user.id])

      const client = yield* HttpClient.HttpClient
      const res = yield* client.get(`/api/teams/${teamA.id}/instances`, { headers: { cookie: cookieHeader } })
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("admin は他チームでも200", () =>
    Effect.gen(function* () {
      const teams = yield* TeamRepo
      const team = new Team({ id: TeamId.make("team-inst-admin"), name: "Inst Admin", teamNumber: 43 })
      yield* teams.create(team)

      const { cookieHeader } = yield* asAdmin()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get(`/api/teams/${team.id}/instances`, { headers: { cookie: cookieHeader } })
      expect(res.status).toBe(200)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("存在しないチームは404", () =>
    Effect.gen(function* () {
      const { cookieHeader } = yield* asAdmin()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/teams/no-such-team/instances", { headers: { cookie: cookieHeader } })
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("POST /api/instances", () => {
  const post = (cookieHeader: string, payload: unknown) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return yield* client.post("/api/instances", {
        headers: { cookie: cookieHeader },
        body: HttpBody.unsafeJson(payload)
      })
    })

  it.effect("非 admin は403", () =>
    Effect.gen(function* () {
      const teams = yield* TeamRepo
      const team = new Team({ id: TeamId.make("team-createinst-403"), name: "CreateInst 403", teamNumber: 50 })
      yield* teams.create(team)

      const { cookieHeader } = yield* login({ isAdmin: false })
      const res = yield* post(cookieHeader, { teamId: team.id, index: 1, privateIp: "10.100.50.10" })
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("存在しないチームは404", () =>
    Effect.gen(function* () {
      const { cookieHeader } = yield* asAdmin()
      const res = yield* post(cookieHeader, { teamId: "no-such-team", index: 1, privateIp: "10.100.50.10" })
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("privateIp がチームサブネット外なら422", () =>
    Effect.gen(function* () {
      const teams = yield* TeamRepo
      const team = new Team({ id: TeamId.make("team-createinst-subnet"), name: "CreateInst Subnet", teamNumber: 51 })
      yield* teams.create(team)

      const { cookieHeader } = yield* asAdmin()
      const res = yield* post(cookieHeader, { teamId: team.id, index: 1, privateIp: "10.100.99.10" })
      expect(res.status).toBe(422)
      const body = yield* res.json
      expect(body).toStrictEqual({ _tag: "TargetIpOutOfSubnet", ip: "10.100.99.10", teamNumber: 51 })
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("正常系: 登録できる", () =>
    Effect.gen(function* () {
      const teams = yield* TeamRepo
      const team = new Team({ id: TeamId.make("team-createinst-ok"), name: "CreateInst OK", teamNumber: 52 })
      yield* teams.create(team)

      const { cookieHeader } = yield* asAdmin()
      const res = yield* post(cookieHeader, { teamId: team.id, index: 1, privateIp: "10.100.52.10" })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { teamId: string; privateIp: string; status: string }
      expect(body.teamId).toBe(team.id)
      expect(body.privateIp).toBe("10.100.52.10")
      expect(body.status).toBe("active")

      const instances = yield* InstanceRepo
      const listed = yield* instances.listByTeam(team.id)
      expect(listed).toHaveLength(1)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("同一 (team, index) の二重登録は409(HttpApiClient でも型付きエラーとして decode できる)", () =>
    Effect.gen(function* () {
      const teams = yield* TeamRepo
      const team = new Team({ id: TeamId.make("team-createinst-dup"), name: "CreateInst Dup", teamNumber: 54 })
      yield* teams.create(team)

      const { cookieHeader } = yield* asAdmin()
      const first = yield* post(cookieHeader, { teamId: team.id, index: 1, privateIp: "10.100.54.10" })
      expect(first.status).toBe(200)

      const second = yield* post(cookieHeader, { teamId: team.id, index: 1, privateIp: "10.100.54.11" })
      expect(second.status).toBe(409)
      const body = yield* second.json
      expect(body).toStrictEqual({ _tag: "DuplicateInstanceIndex", teamId: team.id, index: 1 })

      // HttpApiClient(契約)経由でも型付きエラーとして decode できることを確認する
      const apiClient = yield* makeApiClient(cookieHeader)
      const error = yield* apiClient.instances
        .createInstance({ payload: { teamId: team.id, index: 1, privateIp: "10.100.54.12" } })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(DuplicateInstanceIndex)
      expect(error).toStrictEqual(new DuplicateInstanceIndex({ teamId: team.id, index: 1 }))
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("DELETE /api/instances/:id", () => {
  it.effect("非 admin は403", () =>
    Effect.gen(function* () {
      const { cookieHeader } = yield* login({ isAdmin: false })
      const client = yield* HttpClient.HttpClient
      const res = yield* client.del("/api/instances/no-such-instance", { headers: { cookie: cookieHeader } })
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("admin は204(存在しない id でも冪等)", () =>
    Effect.gen(function* () {
      const { cookieHeader } = yield* asAdmin()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.del("/api/instances/no-such-instance", { headers: { cookie: cookieHeader } })
      expect(res.status).toBe(204)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("正常系: 削除後は listByTeam に現れない", () =>
    Effect.gen(function* () {
      const teams = yield* TeamRepo
      const instances = yield* InstanceRepo
      const team = new Team({ id: TeamId.make("team-delinst"), name: "DelInst", teamNumber: 53 })
      yield* teams.create(team)
      const instance = new Instance({
        id: InstanceId.make("inst-del-1"),
        teamId: team.id,
        index: 1,
        privateIp: "10.100.53.10",
        status: "active"
      })
      yield* instances.create(instance)

      const { cookieHeader } = yield* asAdmin()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.del(`/api/instances/${instance.id}`, { headers: { cookie: cookieHeader } })
      expect(res.status).toBe(204)

      const listed = yield* instances.listByTeam(team.id)
      expect(listed).toStrictEqual([])
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("POST /api/admin/contest/start", () => {
  const start = (cookieHeader: string) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return yield* client.post("/api/admin/contest/start", { headers: { cookie: cookieHeader } })
    })

  it.effect("非 admin は403", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.save(
        new Contest({ id: ContestId.make("contest-start-403"), name: "C", problemKey: "p", status: "preparing" })
      )
      const { cookieHeader } = yield* login({ isAdmin: false })
      const res = yield* start(cookieHeader)
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("コンテスト未作成は404", () =>
    Effect.gen(function* () {
      const { cookieHeader } = yield* asAdmin()
      const res = yield* start(cookieHeader)
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("preparing からは running になる", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.save(
        new Contest({ id: ContestId.make("contest-start-ok"), name: "C", problemKey: "p", status: "preparing" })
      )
      const { cookieHeader } = yield* asAdmin()
      const res = yield* start(cookieHeader)
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { status: string }
      expect(body.status).toBe("running")
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("running からの start は409(不正遷移)", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.save(
        new Contest({ id: ContestId.make("contest-start-conflict"), name: "C", problemKey: "p", status: "running" })
      )
      const { cookieHeader } = yield* asAdmin()
      const res = yield* start(cookieHeader)
      expect(res.status).toBe(409)
      const body = yield* res.json
      expect(body).toStrictEqual({ _tag: "InvalidContestTransition", from: "running", to: "running" })
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("POST /api/admin/contest/finish", () => {
  const finish = (cookieHeader: string) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return yield* client.post("/api/admin/contest/finish", { headers: { cookie: cookieHeader } })
    })

  it.effect("非 admin は403", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.save(
        new Contest({ id: ContestId.make("contest-finish-403"), name: "C", problemKey: "p", status: "running" })
      )
      const { cookieHeader } = yield* login({ isAdmin: false })
      const res = yield* finish(cookieHeader)
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("コンテスト未作成は404", () =>
    Effect.gen(function* () {
      const { cookieHeader } = yield* asAdmin()
      const res = yield* finish(cookieHeader)
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("running からは finished になる", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.save(
        new Contest({ id: ContestId.make("contest-finish-ok"), name: "C", problemKey: "p", status: "running" })
      )
      const { cookieHeader } = yield* asAdmin()
      const res = yield* finish(cookieHeader)
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { status: string }
      expect(body.status).toBe("finished")
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("preparing からの finish は409(不正遷移)", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.save(
        new Contest({ id: ContestId.make("contest-finish-conflict"), name: "C", problemKey: "p", status: "preparing" })
      )
      const { cookieHeader } = yield* asAdmin()
      const res = yield* finish(cookieHeader)
      expect(res.status).toBe(409)
      const body = yield* res.json
      expect(body).toStrictEqual({ _tag: "InvalidContestTransition", from: "preparing", to: "finished" })
    }).pipe(Effect.provide(TestLayer))
  )
})
