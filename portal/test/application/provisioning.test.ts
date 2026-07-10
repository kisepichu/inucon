import { it } from "@effect/vitest"
import { Effect, Either, Exit, Layer, Option } from "effect"
import { describe, expect } from "vitest"
import { newJob, startJob } from "../../src/domain/benchJob.js"
import { Contest } from "../../src/domain/contest.js"
import { InvalidInstanceTransition } from "../../src/domain/errors.js"
import { BenchJobId, ContestId, InstanceId, TeamId, UserId } from "../../src/domain/ids.js"
import { Instance, ipFor, newInstance, vmidFor } from "../../src/domain/instance.js"
import type { ProvisionStep } from "../../src/domain/instance.js"
import { Team } from "../../src/domain/team.js"
import { User } from "../../src/domain/user.js"
import {
  Forbidden,
  InsufficientMemory,
  InstanceInUse,
  ProvisionInProgress,
  QuotaExceeded
} from "../../src/application/errors.js"
import { CloudflareError, CloudflarePort, InstanceRepo, ProxmoxError } from "../../src/application/ports.js"
import { requestCreateInstance, requestDeleteInstance } from "../../src/application/usecases/instances.js"
import { collectTeamAccess, runProvisioning, runTeardown } from "../../src/application/usecases/provisioning.js"
import {
  makeBenchJobRepoTest,
  makeCloudflarePortTest,
  makeContestRepoTest,
  makeGithubKeysPortTest,
  makeInstanceRepoTest,
  makeProxmoxPortTest,
  makeTeamRepoTest,
  ProvisioningConfigTest,
  UuidGenTest
} from "../support/inMemory.js"

const team1Id = TeamId.make("11111111-1111-1111-1111-111111111111")
const team2Id = TeamId.make("22222222-2222-2222-2222-222222222222")
const aliceId = UserId.make("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
const bobId = UserId.make("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
const carolId = UserId.make("cccccccc-cccc-cccc-cccc-cccccccccccc")
const adminId = UserId.make("dddddddd-dddd-dddd-dddd-dddddddddddd")

const team1 = new Team({ id: team1Id, name: "team1", teamNumber: 1 })
const team2 = new Team({ id: team2Id, name: "team2", teamNumber: 2 })

// alice はメール+鍵あり、bob はメール無し・鍵あり(collectTeamAccess の
// 「メール未設定はスキップ、鍵は集約」を検証できる構成)。
const alice = new User({
  id: aliceId,
  githubId: 1,
  githubLogin: "alice",
  displayName: "Alice",
  isAdmin: false,
  email: Option.some("alice@example.com")
})
const bob = new User({
  id: bobId,
  githubId: 2,
  githubLogin: "bob",
  displayName: "Bob",
  isAdmin: false,
  email: Option.none()
})
const carol = new User({
  id: carolId,
  githubId: 3,
  githubLogin: "carol",
  displayName: "Carol",
  isAdmin: false,
  email: Option.some("carol@example.com")
})
const admin = new User({
  id: adminId,
  githubId: 9,
  githubLogin: "admin",
  displayName: "Admin",
  isAdmin: true,
  email: Option.none()
})

const teamRepoLayer = makeTeamRepoTest({
  teams: [team1, team2],
  memberships: [
    { userId: aliceId, teamId: team1Id },
    { userId: bobId, teamId: team1Id },
    { userId: carolId, teamId: team2Id }
  ],
  users: [alice, bob, carol, admin]
})

const githubKeysLayer = makeGithubKeysPortTest({
  alice: ["ssh-ed25519 AAAA alice@host"],
  bob: ["ssh-rsa BBBB bob@host"],
  carol: ["ssh-ed25519 CCCC carol@host"]
})

const contestLayer = (instanceQuota = 3) =>
  makeContestRepoTest(
    Option.some(
      new Contest({ id: ContestId.make("contest-1"), name: "INUCON", problemKey: "p", status: "running", instanceQuota })
    )
  )

const hostname1 = "inucon-team1-1.kisen.one"
const vmid1 = vmidFor(1, 1)
const ip1 = ipFor(1, 1)

const runningInstance = (args: { id: string; teamId: TeamId; index: number; teamNumber: number }) =>
  new Instance({
    id: InstanceId.make(args.id),
    teamId: args.teamId,
    index: args.index,
    vmid: vmidFor(args.teamNumber, args.index),
    privateIp: ipFor(args.teamNumber, args.index),
    status: "running",
    progress: ["clone_done", "configured", "started", "route_done", "access_done"],
    errorMessage: Option.none(),
    createdAt: 0,
    updatedAt: 0
  })

const creatingInstance = (args: {
  id: string
  teamId: TeamId
  index: number
  teamNumber: number
  progress?: ReadonlyArray<ProvisionStep>
  createdAt?: number
}) =>
  new Instance({
    id: InstanceId.make(args.id),
    teamId: args.teamId,
    index: args.index,
    vmid: vmidFor(args.teamNumber, args.index),
    privateIp: ipFor(args.teamNumber, args.index),
    status: "creating",
    progress: args.progress ?? [],
    errorMessage: Option.none(),
    createdAt: args.createdAt ?? 0,
    updatedAt: 0
  })

describe("requestCreateInstance(ガード)", () => {
  const baseGuardLayer = (
    opts: { instances?: ReadonlyArray<Instance>; freeMemBytes?: number; minFreeMemBytes?: number; quota?: number } = {}
  ) =>
    Layer.mergeAll(
      UuidGenTest,
      teamRepoLayer,
      contestLayer(opts.quota ?? 3),
      makeInstanceRepoTest(opts.instances ?? []),
      makeProxmoxPortTest({ freeMemBytes: opts.freeMemBytes ?? 6_000_000_000 }).layer,
      ProvisioningConfigTest({ minFreeMemBytes: opts.minFreeMemBytes ?? 5_000_000_000 })
    )

  it.effect("正常系: creating 行が返る(202 相当)", () =>
    Effect.gen(function* () {
      const instance = yield* requestCreateInstance({ user: alice, teamId: team1Id, index: 1 })
      expect(instance.status).toBe("creating")
      expect(instance.teamId).toBe(team1Id)
      expect(instance.index).toBe(1)
      expect(instance.vmid).toBe(vmid1)
      expect(instance.privateIp).toBe(ip1)
      expect(instance.progress).toStrictEqual([])
    }).pipe(Effect.provide(baseGuardLayer()))
  )

  it.effect("quota 超過(creating+running = quota)は QuotaExceeded", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(requestCreateInstance({ user: alice, teamId: team1Id, index: 3 }))
      expect(exit).toStrictEqual(Exit.fail(new QuotaExceeded({ teamId: team1Id, quota: 2 })))
    }).pipe(
      Effect.provide(
        baseGuardLayer({
          quota: 2,
          instances: [
            runningInstance({ id: "r1", teamId: team1Id, index: 1, teamNumber: 1 }),
            runningInstance({ id: "r2", teamId: team1Id, index: 2, teamNumber: 1 })
          ]
        })
      )
    )
  )

  it.effect("進行中(creating/deleting)が既にあれば ProvisionInProgress", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(requestCreateInstance({ user: alice, teamId: team1Id, index: 2 }))
      expect(exit).toStrictEqual(Exit.fail(new ProvisionInProgress({ teamId: team1Id })))
    }).pipe(
      Effect.provide(
        baseGuardLayer({ instances: [creatingInstance({ id: "c1", teamId: team1Id, index: 1, teamNumber: 1 })] })
      )
    )
  )

  it.effect("空き RAM が閾値未満なら InsufficientMemory(DB 書き込み前に拒否)", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(requestCreateInstance({ user: alice, teamId: team1Id, index: 1 }))
      expect(exit).toStrictEqual(
        Exit.fail(new InsufficientMemory({ freeBytes: 1_000_000_000, requiredBytes: 5_000_000_000 }))
      )
      // ガードで弾かれたので creating 行は作られていない。
      const repo = yield* InstanceRepo
      const rows = yield* repo.listByTeam(team1Id)
      expect(rows).toHaveLength(0)
    }).pipe(Effect.provide(baseGuardLayer({ freeMemBytes: 1_000_000_000, minFreeMemBytes: 5_000_000_000 })))
  )

  it.effect("非メンバーは Forbidden", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(requestCreateInstance({ user: carol, teamId: team1Id, index: 1 }))
      expect(exit).toStrictEqual(Exit.fail(new Forbidden()))
    }).pipe(Effect.provide(baseGuardLayer()))
  )

  it.effect("admin は他チームでも作成できる", () =>
    Effect.gen(function* () {
      const instance = yield* requestCreateInstance({ user: admin, teamId: team1Id, index: 1 })
      expect(instance.status).toBe("creating")
    }).pipe(Effect.provide(baseGuardLayer()))
  )
})

describe("requestDeleteInstance(ガード)", () => {
  const deleteLayer = (
    opts: { instances?: ReadonlyArray<Instance>; jobs?: ReadonlyArray<ReturnType<typeof newJob>> } = {}
  ) =>
    Layer.mergeAll(
      teamRepoLayer,
      makeInstanceRepoTest(opts.instances ?? []),
      makeBenchJobRepoTest(opts.jobs ?? [])
    )

  const runningTeam1 = runningInstance({ id: "run-1", teamId: team1Id, index: 1, teamNumber: 1 })

  it.effect("正常系: running → deleting", () =>
    Effect.gen(function* () {
      const result = yield* requestDeleteInstance({ user: alice, instanceId: runningTeam1.id })
      expect(result.status).toBe("deleting")
      // 台帳にも deleting が保存される。
      const repo = yield* InstanceRepo
      const stored = yield* repo.findById(runningTeam1.id)
      expect(Option.getOrThrow(stored).status).toBe("deleting")
    }).pipe(Effect.provide(deleteLayer({ instances: [runningTeam1] })))
  )

  it.effect("対象 IP を持つ BenchJob が running なら InstanceInUse", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(requestDeleteInstance({ user: alice, instanceId: runningTeam1.id }))
      expect(exit).toStrictEqual(Exit.fail(new InstanceInUse({ instanceId: runningTeam1.id })))
    }).pipe(
      Effect.provide(
        deleteLayer({
          instances: [runningTeam1],
          jobs: [
            Either.getOrThrow(
              startJob(
                newJob({ id: BenchJobId.make("job-1"), teamId: team1Id, targetIp: ip1, targetPort: 80, now: 0 }),
                0
              )
            )
          ]
        })
      )
    )
  )

  it.effect("対象 IP を持つ BenchJob が queued でも InstanceInUse", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(requestDeleteInstance({ user: alice, instanceId: runningTeam1.id }))
      expect(exit).toStrictEqual(Exit.fail(new InstanceInUse({ instanceId: runningTeam1.id })))
    }).pipe(
      Effect.provide(
        deleteLayer({
          instances: [runningTeam1],
          jobs: [newJob({ id: BenchJobId.make("job-2"), teamId: team1Id, targetIp: ip1, targetPort: 80, now: 0 })]
        })
      )
    )
  )

  it.effect("running 以外(creating)からの削除は InvalidInstanceTransition", () =>
    Effect.gen(function* () {
      const creating = creatingInstance({ id: "c-del", teamId: team1Id, index: 1, teamNumber: 1 })
      const exit = yield* Effect.exit(requestDeleteInstance({ user: alice, instanceId: creating.id }))
      expect(exit).toStrictEqual(
        Exit.fail(new InvalidInstanceTransition({ instanceId: creating.id, from: "creating", to: "deleting" }))
      )
    }).pipe(
      Effect.provide(deleteLayer({ instances: [creatingInstance({ id: "c-del", teamId: team1Id, index: 1, teamNumber: 1 })] }))
    )
  )

  it.effect("他チームメンバーは Forbidden", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(requestDeleteInstance({ user: carol, instanceId: runningTeam1.id }))
      expect(exit).toStrictEqual(Exit.fail(new Forbidden()))
    }).pipe(Effect.provide(deleteLayer({ instances: [runningTeam1] })))
  )

  it.effect("存在しない instanceId も Forbidden(ID の存在を漏らさない)", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        requestDeleteInstance({ user: alice, instanceId: InstanceId.make("no-such") })
      )
      expect(exit).toStrictEqual(Exit.fail(new Forbidden()))
    }).pipe(Effect.provide(deleteLayer({ instances: [runningTeam1] })))
  )
})

describe("collectTeamAccess", () => {
  it.effect("メール設定済みメンバーのメールと、全メンバーの鍵を集約する", () =>
    Effect.gen(function* () {
      const access = yield* collectTeamAccess(team1Id)
      expect(access.emails).toStrictEqual(["alice@example.com"])
      expect([...access.sshKeys].sort()).toStrictEqual(["ssh-ed25519 AAAA alice@host", "ssh-rsa BBBB bob@host"])
    }).pipe(Effect.provide(Layer.mergeAll(teamRepoLayer, githubKeysLayer)))
  )

  it.effect("鍵未登録(GithubKeysError)のメンバーはスキップして続行する", () =>
    Effect.gen(function* () {
      const access = yield* collectTeamAccess(team2Id)
      // carol は鍵未登録スタブ(下記)なので鍵は空だがメールは残る。
      expect(access.emails).toStrictEqual(["carol@example.com"])
      expect(access.sshKeys).toStrictEqual([])
    }).pipe(Effect.provide(Layer.mergeAll(teamRepoLayer, makeGithubKeysPortTest({}))))
  )
})

describe("runProvisioning(払い出し saga)", () => {
  const sagaLayer = (initial: Instance) => {
    const proxmox = makeProxmoxPortTest()
    const cloudflare = makeCloudflarePortTest()
    return {
      proxmox,
      cloudflare,
      layer: Layer.mergeAll(
        makeInstanceRepoTest([initial]),
        teamRepoLayer,
        githubKeysLayer,
        proxmox.layer,
        cloudflare.layer,
        ProvisioningConfigTest()
      )
    }
  }

  const sagaLayerWith = (
    initial: Instance,
    failWith: {
      proxmox?: Parameters<typeof makeProxmoxPortTest>[0]
      cloudflare?: Parameters<typeof makeCloudflarePortTest>[0]
    }
  ) => {
    const proxmox = makeProxmoxPortTest(failWith.proxmox)
    const cloudflare = makeCloudflarePortTest(failWith.cloudflare)
    return {
      proxmox,
      cloudflare,
      layer: Layer.mergeAll(
        makeInstanceRepoTest([initial]),
        teamRepoLayer,
        githubKeysLayer,
        proxmox.layer,
        cloudflare.layer,
        ProvisioningConfigTest()
      )
    }
  }

  it.effect("正常系: 全ステップを順に実行し running になる", () =>
    Effect.gen(function* () {
      const initial = creatingInstance({ id: "prov-1", teamId: team1Id, index: 1, teamNumber: 1 })
      const { cloudflare, layer, proxmox } = sagaLayer(initial)
      const result = yield* runProvisioning(initial).pipe(Effect.provide(layer))

      expect(result.status).toBe("running")
      expect(result.progress).toStrictEqual(["clone_done", "configured", "started", "route_done", "access_done"])

      const px = yield* proxmox.getState
      expect(px.clonedVmids).toStrictEqual([vmid1])
      expect(px.configuredVmids).toStrictEqual([vmid1])
      expect(px.vnetByVmid).toStrictEqual({ [vmid1]: "team1" })
      expect(px.startedVmids).toStrictEqual([vmid1])

      const cf = yield* cloudflare.getState
      expect(cf.routesByHostname).toStrictEqual({ [hostname1]: ip1 })
      // メンバーの中でメール設定済み(alice)だけが Access に載る。
      expect(cf.accessEmailsByHostname[hostname1]).toStrictEqual(["alice@example.com"])
    })
  )

  it.effect("途中(ensureAccessApp)失敗時: 作った route/VM を逆順に補償して failed", () =>
    Effect.gen(function* () {
      const initial = creatingInstance({ id: "prov-fail-access", teamId: team1Id, index: 1, teamNumber: 1 })
      const { cloudflare, layer, proxmox } = sagaLayerWith(initial, {
        cloudflare: { failWith: { ensureAccessApp: new CloudflareError({ cause: "boom" }) } }
      })
      const result = yield* runProvisioning(initial).pipe(Effect.provide(layer))

      expect(result.status).toBe("failed")
      expect(Option.isSome(result.errorMessage)).toBe(true)

      // route は作られたが補償で消えている。Access は作られていない。
      const cf = yield* cloudflare.getState
      expect(cf.routesByHostname).toStrictEqual({})
      expect(cf.accessEmailsByHostname).toStrictEqual({})
      // clone 済みなので VM は破棄されている。
      const px = yield* proxmox.getState
      expect(px.destroyedVmids).toStrictEqual([vmid1])
    })
  )

  it.effect("startVm 失敗時: route は作らず、clone 済み VM だけ破棄して failed", () =>
    Effect.gen(function* () {
      const initial = creatingInstance({ id: "prov-fail-start", teamId: team1Id, index: 1, teamNumber: 1 })
      const { cloudflare, layer, proxmox } = sagaLayerWith(initial, {
        proxmox: { failWith: { startVm: new ProxmoxError({ cause: "boom" }) } }
      })
      const result = yield* runProvisioning(initial).pipe(Effect.provide(layer))

      expect(result.status).toBe("failed")
      const cf = yield* cloudflare.getState
      expect(cf.routesByHostname).toStrictEqual({})
      const px = yield* proxmox.getState
      expect(px.destroyedVmids).toStrictEqual([vmid1])
    })
  )

  it.effect("最初の cloneVm 失敗時: 何も作っていないので VM 破棄も呼ばれず failed", () =>
    Effect.gen(function* () {
      const initial = creatingInstance({ id: "prov-fail-clone", teamId: team1Id, index: 1, teamNumber: 1 })
      const { layer, proxmox } = sagaLayerWith(initial, {
        proxmox: { failWith: { cloneVm: new ProxmoxError({ cause: "boom" }) } }
      })
      const result = yield* runProvisioning(initial).pipe(Effect.provide(layer))

      expect(result.status).toBe("failed")
      const px = yield* proxmox.getState
      expect(px.destroyedVmids).toStrictEqual([])
      expect(px.clonedVmids).toStrictEqual([])
    })
  )

  it.effect("再開: progress 途中の行を拾い、残りステップだけ実行して running", () =>
    Effect.gen(function* () {
      const initial = creatingInstance({
        id: "prov-resume",
        teamId: team1Id,
        index: 1,
        teamNumber: 1,
        progress: ["clone_done", "configured", "started"]
      })
      const { cloudflare, layer, proxmox } = sagaLayer(initial)
      const result = yield* runProvisioning(initial).pipe(Effect.provide(layer))

      expect(result.status).toBe("running")
      expect(result.progress).toStrictEqual(["clone_done", "configured", "started", "route_done", "access_done"])

      // 済みステップ(clone/configure/start)は再実行されない。
      const px = yield* proxmox.getState
      expect(px.clonedVmids).toStrictEqual([])
      expect(px.configuredVmids).toStrictEqual([])
      expect(px.startedVmids).toStrictEqual([])
      // 未済ステップ(route/access)だけ実行される。
      const cf = yield* cloudflare.getState
      expect(cf.routesByHostname).toStrictEqual({ [hostname1]: ip1 })
      expect(cf.accessEmailsByHostname[hostname1]).toStrictEqual(["alice@example.com"])
    })
  )
})

describe("runTeardown(撤収 saga)", () => {
  const deletingInstance = new Instance({
    id: InstanceId.make("td-1"),
    teamId: team1Id,
    index: 1,
    vmid: vmid1,
    privateIp: ip1,
    status: "deleting",
    progress: ["clone_done", "configured", "started", "route_done", "access_done"],
    errorMessage: Option.none(),
    createdAt: 0,
    updatedAt: 0
  })

  it.effect("正常系: route/access を消し VM を破棄して deleted", () =>
    Effect.gen(function* () {
      const proxmox = makeProxmoxPortTest()
      const cloudflare = makeCloudflarePortTest()
      const layer = Layer.mergeAll(
        makeInstanceRepoTest([deletingInstance]),
        teamRepoLayer,
        proxmox.layer,
        cloudflare.layer
      )

      const result = yield* Effect.gen(function* () {
        // 事前に route/Access を張っておき、撤収で消えることを確認する。
        const cf = yield* CloudflarePort
        yield* cf.ensureInstanceRoute({ hostname: hostname1, ip: ip1 })
        yield* cf.ensureAccessApp({ hostname: hostname1, emails: ["alice@example.com"] })
        return yield* runTeardown(deletingInstance)
      }).pipe(Effect.provide(layer))

      expect(result.status).toBe("deleted")
      const cf = yield* cloudflare.getState
      expect(cf.routesByHostname).toStrictEqual({})
      expect(cf.accessEmailsByHostname).toStrictEqual({})
      const px = yield* proxmox.getState
      expect(px.destroyedVmids).toStrictEqual([vmid1])
    })
  )

  it.effect("冪等: 2 回実行しても deleted のままで VM 破棄は 1 回だけ", () =>
    Effect.gen(function* () {
      const proxmox = makeProxmoxPortTest()
      const cloudflare = makeCloudflarePortTest()
      const layer = Layer.mergeAll(
        makeInstanceRepoTest([deletingInstance]),
        teamRepoLayer,
        proxmox.layer,
        cloudflare.layer
      )

      const results = yield* Effect.gen(function* () {
        const first = yield* runTeardown(deletingInstance)
        const second = yield* runTeardown(deletingInstance)
        return [first, second] as const
      }).pipe(Effect.provide(layer))

      expect(results[0].status).toBe("deleted")
      expect(results[1].status).toBe("deleted")
      const px = yield* proxmox.getState
      expect(px.destroyedVmids).toStrictEqual([vmid1])
    })
  )

  it.effect("撤収失敗(stopAndDestroyVm)時は failed(手動介入)", () =>
    Effect.gen(function* () {
      const proxmox = makeProxmoxPortTest({ failWith: { stopAndDestroyVm: new ProxmoxError({ cause: "boom" }) } })
      const cloudflare = makeCloudflarePortTest()
      const layer = Layer.mergeAll(
        makeInstanceRepoTest([deletingInstance]),
        teamRepoLayer,
        proxmox.layer,
        cloudflare.layer
      )

      const result = yield* runTeardown(deletingInstance).pipe(Effect.provide(layer))
      expect(result.status).toBe("failed")
      expect(Option.isSome(result.errorMessage)).toBe(true)
    })
  )
})
