import { HttpBody, HttpClient } from "@effect/platform"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { DuplicateInstanceIndex } from "shared"
import { BenchJobId, InstanceId, TeamId } from "../../src/domain/ids.js"
import { BenchJobRepo, ContestRepo, InstanceRepo, TeamRepo } from "../../src/application/ports.js"
import { login } from "../support/login.js"
import { TestLayer, asAdmin, makeApiClient, seedOperationalContest } from "../support/apiTestHelpers.js"
import {
  DEFAULT_TEST_CONTEST_ID,
  makeBenchJob,
  makeContest,
  makeInstance,
  makeTeam
} from "../support/factories.js"

describe("GET /api/teams/:id/instances", () => {
  it.effect("自チームのメンバーは200", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const teams = yield* TeamRepo
      const instances = yield* InstanceRepo
      const team = makeTeam({ id: TeamId.make("team-inst-self"), name: "Inst Self", teamNumber: 40 })
      yield* teams.create(team)
      const instance = makeInstance({
        id: InstanceId.make("inst-self-1"),
        teamId: team.id,
        index: 1,
        vmid: 1140,
        privateIp: "10.100.40.10",
        status: "running",
        progress: ["clone_done", "configured", "started", "route_done", "access_done"]
      })
      yield* instances.create(instance)

      const { user, cookieHeader } = yield* login({ githubLogin: "inst-self-member" })
      yield* teams.setMembers(DEFAULT_TEST_CONTEST_ID, team.id, [user.id])

      const client = yield* HttpClient.HttpClient
      const res = yield* client.get(`/api/teams/${team.id}/instances`, { headers: { cookie: cookieHeader } })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as ReadonlyArray<{ id: string }>
      expect(body.map((i) => i.id)).toStrictEqual(["inst-self-1"])
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("他チームのメンバー(非 admin)は403", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const teams = yield* TeamRepo
      const teamA = makeTeam({ id: TeamId.make("team-inst-other-a"), name: "Inst Other A", teamNumber: 41 })
      const teamB = makeTeam({ id: TeamId.make("team-inst-other-b"), name: "Inst Other B", teamNumber: 42 })
      yield* teams.create(teamA)
      yield* teams.create(teamB)

      const { user, cookieHeader } = yield* login({ githubLogin: "inst-other-member" })
      yield* teams.setMembers(DEFAULT_TEST_CONTEST_ID, teamB.id, [user.id])

      const client = yield* HttpClient.HttpClient
      const res = yield* client.get(`/api/teams/${teamA.id}/instances`, { headers: { cookie: cookieHeader } })
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("admin は他チームでも200", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const teams = yield* TeamRepo
      const team = makeTeam({ id: TeamId.make("team-inst-admin"), name: "Inst Admin", teamNumber: 43 })
      yield* teams.create(team)

      const { cookieHeader } = yield* asAdmin()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get(`/api/teams/${team.id}/instances`, { headers: { cookie: cookieHeader } })
      expect(res.status).toBe(200)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("存在しないチームは404", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
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
      yield* seedOperationalContest("preparing")
      const teams = yield* TeamRepo
      const team = makeTeam({ id: TeamId.make("team-createinst-403"), name: "CreateInst 403", teamNumber: 50 })
      yield* teams.create(team)

      const { cookieHeader } = yield* login({ isAdmin: false })
      const res = yield* post(cookieHeader, { teamId: team.id, index: 1, privateIp: "10.100.50.10" })
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("存在しないチームは404", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const { cookieHeader } = yield* asAdmin()
      const res = yield* post(cookieHeader, { teamId: "no-such-team", index: 1, privateIp: "10.100.50.10" })
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("privateIp がチームサブネット外なら422", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const teams = yield* TeamRepo
      const team = makeTeam({ id: TeamId.make("team-createinst-subnet"), name: "CreateInst Subnet", teamNumber: 51 })
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
      yield* seedOperationalContest("preparing")
      const teams = yield* TeamRepo
      const team = makeTeam({ id: TeamId.make("team-createinst-ok"), name: "CreateInst OK", teamNumber: 52 })
      yield* teams.create(team)

      const { cookieHeader } = yield* asAdmin()
      const res = yield* post(cookieHeader, { teamId: team.id, index: 1, privateIp: "10.100.52.10" })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { teamId: string; privateIp: string; status: string }
      expect(body.teamId).toBe(team.id)
      expect(body.privateIp).toBe("10.100.52.10")
      expect(body.status).toBe("running")

      const instances = yield* InstanceRepo
      const listed = yield* instances.listByTeam(DEFAULT_TEST_CONTEST_ID, team.id)
      expect(listed).toHaveLength(1)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("vmid 省略時は vmidFor(teamNumber, index) の計算値が保存される", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const teams = yield* TeamRepo
      const team = makeTeam({ id: TeamId.make("team-createinst-vmid-default"), name: "CreateInst VmidDefault", teamNumber: 55 })
      yield* teams.create(team)

      const { cookieHeader } = yield* asAdmin()
      const res = yield* post(cookieHeader, { teamId: team.id, index: 1, privateIp: "10.100.55.10" })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { vmid: number }
      expect(body.vmid).toBe(6501)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("vmid 明示指定時はその値が vmidFor の計算式を無視して保存される(Terraform 製 VM の台帳取り込み)", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const teams = yield* TeamRepo
      const team = makeTeam({ id: TeamId.make("team-createinst-vmid-explicit"), name: "CreateInst VmidExplicit", teamNumber: 56 })
      yield* teams.create(team)

      const { cookieHeader } = yield* asAdmin()
      const res = yield* post(cookieHeader, { teamId: team.id, index: 1, privateIp: "10.100.56.10", vmid: 9999 })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { vmid: number }
      expect(body.vmid).toBe(9999)

      const instances = yield* InstanceRepo
      const listed = yield* instances.listByTeam(DEFAULT_TEST_CONTEST_ID, team.id)
      expect(listed[0].vmid).toBe(9999)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("同一 (team, index) の二重登録は409(HttpApiClient でも型付きエラーとして decode できる)", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const teams = yield* TeamRepo
      const team = makeTeam({ id: TeamId.make("team-createinst-dup"), name: "CreateInst Dup", teamNumber: 54 })
      yield* teams.create(team)

      const { cookieHeader } = yield* asAdmin()
      const first = yield* post(cookieHeader, { teamId: team.id, index: 1, privateIp: "10.100.54.10" })
      expect(first.status).toBe(200)

      const second = yield* post(cookieHeader, { teamId: team.id, index: 1, privateIp: "10.100.54.11" })
      expect(second.status).toBe(409)
      const body = yield* second.json
      expect(body).toStrictEqual({ _tag: "DuplicateInstanceIndex", teamId: team.id, index: 1 })

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
      yield* seedOperationalContest("preparing")
      const teams = yield* TeamRepo
      const instances = yield* InstanceRepo
      const team = makeTeam({ id: TeamId.make("team-delinst"), name: "DelInst", teamNumber: 53 })
      yield* teams.create(team)
      const instance = makeInstance({
        id: InstanceId.make("inst-del-1"),
        teamId: team.id,
        index: 1,
        vmid: 1153,
        privateIp: "10.100.53.10",
        status: "running",
        progress: ["clone_done", "configured", "started", "route_done", "access_done"]
      })
      yield* instances.create(instance)

      const { cookieHeader } = yield* asAdmin()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.del(`/api/instances/${instance.id}`, { headers: { cookie: cookieHeader } })
      expect(res.status).toBe(204)

      const listed = yield* instances.listByTeam(DEFAULT_TEST_CONTEST_ID, team.id)
      expect(listed).toStrictEqual([])
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("POST /api/teams/:id/instances", () => {
  const setupRunningContest = (quota: number) =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      const contest = makeContest({ id: DEFAULT_TEST_CONTEST_ID, status: "running", instanceQuota: quota })
      yield* contests.create(contest)
      return contest
    })

  const post = (cookieHeader: string, teamId: string, payload: unknown) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return yield* client.post(`/api/teams/${teamId}/instances`, {
        headers: { cookie: cookieHeader },
        body: HttpBody.unsafeJson(payload)
      })
    })

  it.effect("自チームのメンバーは追加できる(creating 行が返る)", () =>
    Effect.gen(function* () {
      yield* setupRunningContest(3)
      const teams = yield* TeamRepo
      const team = makeTeam({ id: TeamId.make("team-createteaminst-ok"), name: "CreateTeamInst OK", teamNumber: 70 })
      yield* teams.create(team)
      const { user, cookieHeader } = yield* login({ githubLogin: "createteaminst-member" })
      yield* teams.setMembers(DEFAULT_TEST_CONTEST_ID, team.id, [user.id])

      const res = yield* post(cookieHeader, team.id, {})
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { status: string; teamId: string; index: number; vmid: number; privateIp: string }
      expect(body.status).toBe("creating")
      expect(body.teamId).toBe(team.id)
      expect(body.index).toBe(1)
      expect(body.vmid).toBe(1000 + 70 * 100 + 1)
      expect(body.privateIp).toBe("10.100.70.11")
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("他チームのメンバー(非 admin)は403", () =>
    Effect.gen(function* () {
      yield* setupRunningContest(3)
      const teams = yield* TeamRepo
      const teamA = makeTeam({ id: TeamId.make("team-createteaminst-a"), name: "A", teamNumber: 71 })
      const teamB = makeTeam({ id: TeamId.make("team-createteaminst-b"), name: "B", teamNumber: 72 })
      yield* teams.create(teamA)
      yield* teams.create(teamB)
      const { user, cookieHeader } = yield* login({ githubLogin: "createteaminst-other" })
      yield* teams.setMembers(DEFAULT_TEST_CONTEST_ID, teamB.id, [user.id])

      const res = yield* post(cookieHeader, teamA.id, {})
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("存在しないチームは404", () =>
    Effect.gen(function* () {
      yield* setupRunningContest(3)
      const { cookieHeader } = yield* asAdmin()
      const res = yield* post(cookieHeader, "no-such-team", {})
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("quota 到達は409(QuotaExceeded)", () =>
    Effect.gen(function* () {
      yield* setupRunningContest(1)
      const teams = yield* TeamRepo
      const team = makeTeam({ id: TeamId.make("team-createteaminst-quota"), name: "Quota", teamNumber: 73 })
      yield* teams.create(team)
      const { user, cookieHeader } = yield* login({ githubLogin: "createteaminst-quota" })
      yield* teams.setMembers(DEFAULT_TEST_CONTEST_ID, team.id, [user.id])

      const first = yield* post(cookieHeader, team.id, {})
      expect(first.status).toBe(200)

      const second = yield* post(cookieHeader, team.id, {})
      expect(second.status).toBe(409)
      const body = yield* second.json
      expect(body).toStrictEqual({ _tag: "QuotaExceeded", teamId: team.id, quota: 1 })
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("進行中(creating)がある場合は409(ProvisionInProgress)", () =>
    Effect.gen(function* () {
      yield* setupRunningContest(3)
      const teams = yield* TeamRepo
      const team = makeTeam({ id: TeamId.make("team-createteaminst-inprogress"), name: "InProgress", teamNumber: 74 })
      yield* teams.create(team)
      const { user, cookieHeader } = yield* login({ githubLogin: "createteaminst-inprogress" })
      yield* teams.setMembers(DEFAULT_TEST_CONTEST_ID, team.id, [user.id])

      const first = yield* post(cookieHeader, team.id, {})
      expect(first.status).toBe(200)

      const second = yield* post(cookieHeader, team.id, {})
      expect(second.status).toBe(409)
      const body = yield* second.json
      expect(body).toStrictEqual({ _tag: "ProvisionInProgress", teamId: team.id })
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("DELETE /api/teams/:id/instances/:instanceId", () => {
  const del = (cookieHeader: string, teamId: string, instanceId: string) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return yield* client.del(`/api/teams/${teamId}/instances/${instanceId}`, { headers: { cookie: cookieHeader } })
    })

  it.effect("正常系: running は204でdeletingへ遷移する(行は消えない)", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const teams = yield* TeamRepo
      const instances = yield* InstanceRepo
      const team = makeTeam({ id: TeamId.make("team-delteaminst-ok"), name: "DelTeamInst OK", teamNumber: 90 })
      yield* teams.create(team)
      const instance = makeInstance({
        id: InstanceId.make("inst-delteaminst-ok"),
        teamId: team.id,
        index: 1,
        vmid: 1901,
        privateIp: "10.100.90.10",
        status: "running",
        progress: ["clone_done", "configured", "started", "route_done", "access_done"]
      })
      yield* instances.create(instance)
      const { user, cookieHeader } = yield* login({ githubLogin: "delteaminst-member" })
      yield* teams.setMembers(DEFAULT_TEST_CONTEST_ID, team.id, [user.id])

      const res = yield* del(cookieHeader, team.id, instance.id)
      expect(res.status).toBe(204)

      const listed = yield* instances.listByTeam(DEFAULT_TEST_CONTEST_ID, team.id)
      expect(listed).toHaveLength(1)
      expect(listed[0].status).toBe("deleting")
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("他チームのメンバーは403", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const teams = yield* TeamRepo
      const instances = yield* InstanceRepo
      const teamA = makeTeam({ id: TeamId.make("team-delteaminst-a"), name: "A", teamNumber: 91 })
      const teamB = makeTeam({ id: TeamId.make("team-delteaminst-b"), name: "B", teamNumber: 92 })
      yield* teams.create(teamA)
      yield* teams.create(teamB)
      const instance = makeInstance({
        id: InstanceId.make("inst-delteaminst-other"),
        teamId: teamA.id,
        index: 1,
        vmid: 1911,
        privateIp: "10.100.91.10",
        status: "running"
      })
      yield* instances.create(instance)
      const { user, cookieHeader } = yield* login({ githubLogin: "delteaminst-other" })
      yield* teams.setMembers(DEFAULT_TEST_CONTEST_ID, teamB.id, [user.id])

      const res = yield* del(cookieHeader, teamA.id, instance.id)
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("creating の削除は409(InvalidInstanceTransition)", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const teams = yield* TeamRepo
      const instances = yield* InstanceRepo
      const team = makeTeam({ id: TeamId.make("team-delteaminst-creating"), name: "Creating", teamNumber: 93 })
      yield* teams.create(team)
      const instance = makeInstance({
        id: InstanceId.make("inst-delteaminst-creating"),
        teamId: team.id,
        index: 1,
        vmid: 1931,
        privateIp: "10.100.93.10",
        status: "creating"
      })
      yield* instances.create(instance)
      const { user, cookieHeader } = yield* login({ githubLogin: "delteaminst-creating" })
      yield* teams.setMembers(DEFAULT_TEST_CONTEST_ID, team.id, [user.id])

      const res = yield* del(cookieHeader, team.id, instance.id)
      expect(res.status).toBe(409)
      const body = yield* res.json
      expect(body).toStrictEqual({
        _tag: "InvalidInstanceTransition",
        instanceId: instance.id,
        from: "creating",
        to: "deleting"
      })
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("同一チームに他の進行中(creating)がある場合は409(ProvisionInProgress)", () =>
    Effect.gen(function* () {
      yield* seedOperationalContest("preparing")
      const teams = yield* TeamRepo
      const instances = yield* InstanceRepo
      const team = makeTeam({ id: TeamId.make("team-delteaminst-inprogress"), name: "InProgress", teamNumber: 95 })
      yield* teams.create(team)
      const target = makeInstance({
        id: InstanceId.make("inst-delteaminst-inprogress-target"),
        teamId: team.id,
        index: 1,
        vmid: 1951,
        privateIp: "10.100.95.10",
        status: "running"
      })
      const other = makeInstance({
        id: InstanceId.make("inst-delteaminst-inprogress-other"),
        teamId: team.id,
        index: 2,
        vmid: 1952,
        privateIp: "10.100.95.11",
        status: "creating"
      })
      yield* instances.create(target)
      yield* instances.create(other)
      const { user, cookieHeader } = yield* login({ githubLogin: "delteaminst-inprogress" })
      yield* teams.setMembers(DEFAULT_TEST_CONTEST_ID, team.id, [user.id])

      const res = yield* del(cookieHeader, team.id, target.id)
      expect(res.status).toBe(409)
      const body = yield* res.json
      expect(body).toStrictEqual({ _tag: "ProvisionInProgress", teamId: team.id })

      const listed = yield* instances.listByTeam(DEFAULT_TEST_CONTEST_ID, team.id)
      expect(listed.find((i) => i.id === target.id)?.status).toBe("running")
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("ベンチ対象中(queued)は409(InstanceInUse)", () =>
    Effect.gen(function* () {
      // running contest でないと BenchJob の enqueue は通らない(purpose='competition' は running のみ)。
      const contests = yield* ContestRepo
      yield* contests.create(makeContest({ id: DEFAULT_TEST_CONTEST_ID, status: "running" }))
      const teams = yield* TeamRepo
      const instances = yield* InstanceRepo
      const jobs = yield* BenchJobRepo
      const team = makeTeam({ id: TeamId.make("team-delteaminst-inuse"), name: "InUse", teamNumber: 94 })
      yield* teams.create(team)
      const instance = makeInstance({
        id: InstanceId.make("inst-delteaminst-inuse"),
        teamId: team.id,
        index: 1,
        vmid: 1941,
        privateIp: "10.100.94.10",
        status: "running"
      })
      yield* instances.create(instance)
      yield* jobs.insertIfAllowed(
        makeBenchJob({
          id: BenchJobId.make("job-delteaminst-inuse"),
          teamId: team.id,
          targetIp: instance.privateIp,
          targetPort: 80,
          status: "queued"
        })
      )
      const { user, cookieHeader } = yield* login({ githubLogin: "delteaminst-inuse" })
      yield* teams.setMembers(DEFAULT_TEST_CONTEST_ID, team.id, [user.id])

      const res = yield* del(cookieHeader, team.id, instance.id)
      expect(res.status).toBe(409)
      const body = yield* res.json
      expect(body).toStrictEqual({ _tag: "InstanceInUse", instanceId: instance.id })
    }).pipe(Effect.provide(TestLayer))
  )
})
