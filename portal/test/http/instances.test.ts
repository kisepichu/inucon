import { HttpBody, HttpClient } from "@effect/platform"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { DuplicateInstanceIndex } from "shared"
import { Instance } from "../../src/domain/instance.js"
import { InstanceId, TeamId } from "../../src/domain/ids.js"
import { Team } from "../../src/domain/team.js"
import { InstanceRepo, TeamRepo } from "../../src/application/ports.js"
import { login } from "../support/login.js"
import { TestLayer, asAdmin, makeApiClient } from "../support/apiTestHelpers.js"

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
