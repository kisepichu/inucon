import { it } from "@effect/vitest"
import { Effect, Either, Exit, Layer, Option } from "effect"
import { describe, expect } from "vitest"
import { newJob, startJob } from "../../src/domain/benchJob.js"
import { InvalidInstanceTransition } from "../../src/domain/errors.js"
import { BenchJobId, InstanceId, TeamId, UserId } from "../../src/domain/ids.js"
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
  makeInviteRepoTest,
  makeProxmoxPortTest,
  makeTeamRepoTest,
  ProvisioningConfigTest,
  UuidGenTest
} from "../support/inMemory.js"
import { makeContest } from "../support/factories.js"

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

// 招待ゼロ(team_invites 空)。collectTeamAccess はメンバーのみを集約する。
const inviteRepoLayer = makeInviteRepoTest([])

const contestLayer = (instanceQuota = 3) =>
  makeContestRepoTest(
    Option.some(makeContest({ status: "running", instanceQuota }))
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
      const instance = yield* requestCreateInstance({ user: alice, teamId: team1Id })
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
      const exit = yield* Effect.exit(requestCreateInstance({ user: alice, teamId: team1Id }))
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
      const exit = yield* Effect.exit(requestCreateInstance({ user: alice, teamId: team1Id }))
      expect(exit).toStrictEqual(Exit.fail(new ProvisionInProgress({ teamId: team1Id })))
    }).pipe(
      Effect.provide(
        baseGuardLayer({ instances: [creatingInstance({ id: "c1", teamId: team1Id, index: 1, teamNumber: 1 })] })
      )
    )
  )

  it.effect("空き RAM が閾値未満なら InsufficientMemory(DB 書き込み前に拒否)", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(requestCreateInstance({ user: alice, teamId: team1Id }))
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
      const exit = yield* Effect.exit(requestCreateInstance({ user: carol, teamId: team1Id }))
      expect(exit).toStrictEqual(Exit.fail(new Forbidden()))
    }).pipe(Effect.provide(baseGuardLayer()))
  )

  it.effect("admin は他チームでも作成できる", () =>
    Effect.gen(function* () {
      const instance = yield* requestCreateInstance({ user: admin, teamId: team1Id })
      expect(instance.status).toBe("creating")
    }).pipe(Effect.provide(baseGuardLayer()))
  )

  // ガード順序(Task 4 レビュー M5): quota/進行中は DB 読み取りだけの安価な
  // 判定なので、Proxmox への HTTP 呼び出しを伴う RAM ガードより先に評価する。
  // quota 超過 と RAM 不足の両方が同時に成り立つ状況を作り、返るエラーが
  // QuotaExceeded(DB 側)であって InsufficientMemory(RAM 側)ではないことを
  // 確認することで、DB チェックが先に fail-fast していることを検証する。
  it.effect("quota 超過かつ RAM 不足が同時に成り立つ場合、安価な quota チェックが先に効く(QuotaExceeded)", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(requestCreateInstance({ user: alice, teamId: team1Id }))
      expect(exit).toStrictEqual(Exit.fail(new QuotaExceeded({ teamId: team1Id, quota: 2 })))
    }).pipe(
      Effect.provide(
        baseGuardLayer({
          quota: 2,
          freeMemBytes: 1_000_000_000,
          minFreeMemBytes: 5_000_000_000,
          instances: [
            runningInstance({ id: "r1", teamId: team1Id, index: 1, teamNumber: 1 }),
            runningInstance({ id: "r2", teamId: team1Id, index: 2, teamNumber: 1 })
          ]
        })
      )
    )
  )

  it.effect("進行中かつ RAM 不足が同時に成り立つ場合、安価な進行中チェックが先に効く(ProvisionInProgress)", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(requestCreateInstance({ user: alice, teamId: team1Id }))
      expect(exit).toStrictEqual(Exit.fail(new ProvisionInProgress({ teamId: team1Id })))
    }).pipe(
      Effect.provide(
        baseGuardLayer({
          freeMemBytes: 1_000_000_000,
          minFreeMemBytes: 5_000_000_000,
          instances: [creatingInstance({ id: "c1", teamId: team1Id, index: 1, teamNumber: 1 })]
        })
      )
    )
  )
})

// Task 6 レビュー #1: index はクライアント指定ではなくサーバー側で
// 「当該チームの active(creating/running)でない、1..instanceQuota の
// もっとも小さい空き」を採番する。vmid/privateIp 不変条件(vmid = 1000 +
// teamNumber*100 + index、ipFor = 10.100.<tn>.1<index>)は index が
// instanceQuota 以下であることに依存するため、ここではその採番ロジック
// そのものを検証する(requestCreateInstance 自体は index を引数に取らない)。
describe("requestCreateInstance(index のサーバー採番)", () => {
  const indexLayer = (opts: { instances?: ReadonlyArray<Instance>; quota?: number } = {}) =>
    Layer.mergeAll(
      UuidGenTest,
      teamRepoLayer,
      contestLayer(opts.quota ?? 3),
      makeInstanceRepoTest(opts.instances ?? []),
      makeProxmoxPortTest({ freeMemBytes: 6_000_000_000 }).layer,
      ProvisioningConfigTest({ minFreeMemBytes: 5_000_000_000 })
    )

  it.effect("空の台帳への最初の追加は index=1(quota >= 3)", () =>
    Effect.gen(function* () {
      const instance = yield* requestCreateInstance({ user: alice, teamId: team1Id })
      expect(instance.index).toBe(1)
      expect(instance.vmid).toBe(vmidFor(1, 1))
      expect(instance.privateIp).toBe(ipFor(1, 1))
    }).pipe(Effect.provide(indexLayer({ quota: 3 })))
  )

  it.effect("active な index=1 が既にあれば次は index=2 を採番する", () =>
    Effect.gen(function* () {
      const instance = yield* requestCreateInstance({ user: alice, teamId: team1Id })
      expect(instance.index).toBe(2)
      expect(instance.vmid).toBe(vmidFor(1, 2))
      expect(instance.privateIp).toBe(ipFor(1, 2))
    }).pipe(
      Effect.provide(
        indexLayer({
          quota: 3,
          instances: [runningInstance({ id: "r1", teamId: team1Id, index: 1, teamNumber: 1 })]
        })
      )
    )
  )

  // index=1 は deleted(non-active)、index=2 は running(active)という状態を
  // 想定する。「削除→再追加を繰り返すと index が増え続ける」旧 UI ロジック
  // (nextInstanceIndex = active の max+1)の問題がサーバー採番では起きない
  // (最小の空き index=1 を再利用し、単調増加しない)ことを確認する。
  const deletedIndex1 = new Instance({
    id: InstanceId.make("deleted-1"),
    teamId: team1Id,
    index: 1,
    vmid: vmidFor(1, 1),
    privateIp: ipFor(1, 1),
    status: "deleted",
    progress: ["clone_done", "configured", "started", "route_done", "access_done"],
    errorMessage: Option.none(),
    createdAt: 0,
    updatedAt: 0
  })

  it.effect("index=1 が(削除により non-active になって)解放されていれば、単調増加せず最小の空き index=1 を再利用する", () =>
    Effect.gen(function* () {
      const instance = yield* requestCreateInstance({ user: alice, teamId: team1Id })
      expect(instance.index).toBe(1)
      expect(instance.vmid).toBe(vmidFor(1, 1))
      expect(instance.privateIp).toBe(ipFor(1, 1))
    }).pipe(
      Effect.provide(
        indexLayer({
          quota: 3,
          instances: [deletedIndex1, runningInstance({ id: "r2", teamId: team1Id, index: 2, teamNumber: 1 })]
        })
      )
    )
  )

  const failedIndex2 = new Instance({
    id: InstanceId.make("failed-idx-2"),
    teamId: team1Id,
    index: 2,
    vmid: vmidFor(1, 2),
    privateIp: ipFor(1, 2),
    status: "failed",
    progress: ["clone_done"],
    errorMessage: Option.some("boom"),
    createdAt: 0,
    updatedAt: 0
  })

  // Task 6 レビュー #A: quota は creating+running の「数」だけを見ているため、
  // failed/deleting の行がある場合 activeCount < quota でもその index は
  // まだ「非 deleted」として占有されている。旧実装(active=creating/running
  // のみ除外)だと failed の index=2 を新規作成が再利用し、後でその failed 行
  // を削除すると新インスタンスの vmid/IP を共有する VM ごと壊れてしまう。
  it.effect("failed 行の index は再利用しない(vmid/IP 衝突・VM 破壊の防止)", () =>
    Effect.gen(function* () {
      const instance = yield* requestCreateInstance({ user: alice, teamId: team1Id })
      // index=1(running)と index=2(failed)はどちらも占有中なので、
      // 新規作成は index=3 を採番する(1 や 2 を再利用しない)。
      expect(instance.index).toBe(3)
      expect(instance.vmid).toBe(vmidFor(1, 3))
      expect(instance.privateIp).toBe(ipFor(1, 3))
    }).pipe(
      Effect.provide(
        indexLayer({
          quota: 3,
          instances: [runningInstance({ id: "r1", teamId: team1Id, index: 1, teamNumber: 1 }), failedIndex2]
        })
      )
    )
  )

  const deletedIndex2 = new Instance({
    id: InstanceId.make("deleted-idx-2"),
    teamId: team1Id,
    index: 2,
    vmid: vmidFor(1, 2),
    privateIp: ipFor(1, 2),
    status: "deleted",
    progress: ["clone_done", "configured", "started", "route_done", "access_done"],
    errorMessage: Option.none(),
    createdAt: 0,
    updatedAt: 0
  })

  // deleted になった index はもう占有していないので再利用してよい(上の
  // 「index=1 が解放されていれば再利用する」テストと同趣旨だが、deleting/
  // failed とは異なり deleted だけが「空き」として扱われることを明示する)。
  it.effect("deleted 行の index は再利用できる", () =>
    Effect.gen(function* () {
      const instance = yield* requestCreateInstance({ user: alice, teamId: team1Id })
      expect(instance.index).toBe(2)
      expect(instance.vmid).toBe(vmidFor(1, 2))
      expect(instance.privateIp).toBe(ipFor(1, 2))
    }).pipe(
      Effect.provide(
        indexLayer({
          quota: 3,
          instances: [runningInstance({ id: "r1", teamId: team1Id, index: 1, teamNumber: 1 }), deletedIndex2]
        })
      )
    )
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

  // I4: failed(C1 の孤児 VM や途中失敗の残骸)も削除経路を受理し、掃除(撤収
  // saga)に乗せられることを確認する。domain の beginDeleting は元々
  // running/failed 両方から deleting への遷移を許していたが、旧
  // requestDeleteInstance は running のみ受理しており failed を掃除する手段が
  // 無かった。
  it.effect("failed インスタンスも削除できる(running/failed → deleting)", () =>
    Effect.gen(function* () {
      const failedInstance = new Instance({
        id: InstanceId.make("failed-1"),
        teamId: team1Id,
        index: 1,
        vmid: vmidFor(1, 1),
        privateIp: ipFor(1, 1),
        status: "failed",
        progress: ["clone_done"],
        errorMessage: Option.some("boom"),
        createdAt: 0,
        updatedAt: 0
      })
      const result = yield* requestDeleteInstance({ user: alice, instanceId: failedInstance.id })
      expect(result.status).toBe("deleting")
      const repo = yield* InstanceRepo
      const stored = yield* repo.findById(failedInstance.id)
      expect(Option.getOrThrow(stored).status).toBe("deleting")
    }).pipe(
      Effect.provide(
        deleteLayer({
          instances: [
            new Instance({
              id: InstanceId.make("failed-1"),
              teamId: team1Id,
              index: 1,
              vmid: vmidFor(1, 1),
              privateIp: ipFor(1, 1),
              status: "failed",
              progress: ["clone_done"],
              errorMessage: Option.some("boom"),
              createdAt: 0,
              updatedAt: 0
            })
          ]
        })
      )
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
    }).pipe(Effect.provide(Layer.mergeAll(teamRepoLayer, githubKeysLayer, inviteRepoLayer)))
  )

  it.effect("鍵未登録(GithubKeysError)のメンバーはスキップして続行する", () =>
    Effect.gen(function* () {
      const access = yield* collectTeamAccess(team2Id)
      // carol は鍵未登録スタブ(下記)なので鍵は空だがメールは残る。
      expect(access.emails).toStrictEqual(["carol@example.com"])
      expect(access.sshKeys).toStrictEqual([])
    }).pipe(Effect.provide(Layer.mergeAll(teamRepoLayer, makeGithubKeysPortTest({}), inviteRepoLayer)))
  )

  it.effect("email 未登録メンバーは missingEmailLogins に載る(Access には含めない)", () =>
    Effect.gen(function* () {
      const access = yield* collectTeamAccess(team1Id)
      // bob は email 未設定。emails には載らず、missingEmailLogins に github_login。
      expect(access.emails).toStrictEqual(["alice@example.com"])
      expect(access.missingEmailLogins).toStrictEqual(["bob"])
    }).pipe(Effect.provide(Layer.mergeAll(teamRepoLayer, githubKeysLayer, inviteRepoLayer)))
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
        inviteRepoLayer,
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
        inviteRepoLayer,
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

  it.effect(
    "最初の cloneVm 失敗時: cloneVm は未成功だが補償は progress 非依存で毎回全部試みる(C1、冪等なので無害)",
    () =>
      Effect.gen(function* () {
        const initial = creatingInstance({ id: "prov-fail-clone", teamId: team1Id, index: 1, teamNumber: 1 })
        const { layer, proxmox } = sagaLayerWith(initial, {
          proxmox: { failWith: { cloneVm: new ProxmoxError({ cause: "boom" }) } }
        })
        const result = yield* runProvisioning(initial).pipe(Effect.provide(layer))

        expect(result.status).toBe("failed")
        const px = yield* proxmox.getState
        // cloneVm 自体は失敗して何も作っていないが、補償(compensate)は
        // progress の内容を見ずに stopAndDestroyVm を必ず呼ぶ(C1 修正:
        // 「progress 未保存だが実は VM が存在する」ケースを取りこぼさないため)。
        // stopAndDestroyVm は冪等なので、対象が無くても呼ぶこと自体は無害。
        expect(px.destroyedVmids).toStrictEqual([vmid1])
        expect(px.clonedVmids).toStrictEqual([])
      })
  )

  it.effect("再入可能性(C1): クラッシュ前に cloneVm だけ成功していた場合、再開時は vmExists=true で clone をスキップする", () =>
    Effect.gen(function* () {
      // progress は保存されなかった(= [])が、Proxmox 上には既に vmid の VM が
      // 存在する状態(クラッシュ前の cloneVm 成功・persistStep 失敗を模す)。
      const initial = creatingInstance({ id: "prov-resume-clone", teamId: team1Id, index: 1, teamNumber: 1 })
      const proxmox = makeProxmoxPortTest({ existingVmids: [vmid1] })
      const cloudflare = makeCloudflarePortTest()
      const layer = Layer.mergeAll(
        makeInstanceRepoTest([initial]),
        teamRepoLayer,
        githubKeysLayer,
        inviteRepoLayer,
        proxmox.layer,
        cloudflare.layer,
        ProvisioningConfigTest()
      )

      const result = yield* runProvisioning(initial).pipe(Effect.provide(layer))

      expect(result.status).toBe("running")
      expect(result.progress).toStrictEqual(["clone_done", "configured", "started", "route_done", "access_done"])
      // cloneVm は一度も呼ばれていない(スキップされた)。
      const px = yield* proxmox.getState
      expect(px.clonedVmids).toStrictEqual([])
    })
  )

  it.effect(
    "再入可能性(C1): クラッシュ前に cloneVm だけ成功 → 別ステップで失敗した場合、補償は vmExists=true の VM を stopAndDestroy する",
    () =>
      Effect.gen(function* () {
        // progress=[](未保存)だが VM は既に存在し、configureCloudInit で失敗
        // させて補償に到達させる。旧実装(progress.includes("clone_done") を
        // 見て絞る補償)だとここで stopAndDestroyVm が呼ばれず孤児 VM が残る
        // (C1 の核心のバグ)。
        const initial = creatingInstance({ id: "prov-resume-fail", teamId: team1Id, index: 1, teamNumber: 1 })
        const proxmox = makeProxmoxPortTest({
          existingVmids: [vmid1],
          failWith: { configureCloudInit: new ProxmoxError({ cause: "boom" }) }
        })
        const cloudflare = makeCloudflarePortTest()
        const layer = Layer.mergeAll(
          makeInstanceRepoTest([initial]),
          teamRepoLayer,
          githubKeysLayer,
          inviteRepoLayer,
          proxmox.layer,
          cloudflare.layer,
          ProvisioningConfigTest()
        )

        const result = yield* runProvisioning(initial).pipe(Effect.provide(layer))

        expect(result.status).toBe("failed")
        const px = yield* proxmox.getState
        expect(px.clonedVmids).toStrictEqual([])
        expect(px.destroyedVmids).toStrictEqual([vmid1])
      })
  )

  it.effect("RAM 再検証(I2): clone 直前に空きが閾値未満なら InsufficientMemory で failed(補償も試みる)", () =>
    Effect.gen(function* () {
      const initial = creatingInstance({ id: "prov-ram-fail", teamId: team1Id, index: 1, teamNumber: 1 })
      const proxmox = makeProxmoxPortTest({ freeMemBytes: 1_000_000_000 })
      const cloudflare = makeCloudflarePortTest()
      const layer = Layer.mergeAll(
        makeInstanceRepoTest([initial]),
        teamRepoLayer,
        githubKeysLayer,
        inviteRepoLayer,
        proxmox.layer,
        cloudflare.layer,
        ProvisioningConfigTest({ minFreeMemBytes: 5_000_000_000 })
      )

      const result = yield* runProvisioning(initial).pipe(Effect.provide(layer))

      expect(result.status).toBe("failed")
      expect(Option.isSome(result.errorMessage)).toBe(true)
      const px = yield* proxmox.getState
      // 空き不足でガードに引っかかったので cloneVm は呼ばれていない。
      expect(px.clonedVmids).toStrictEqual([])
    })
  )

  it.effect("RAM 再検証(I2): 既に vmExists=true(clone 済み)なら RAM 不足でも clone をスキップして進む", () =>
    Effect.gen(function* () {
      // 既に clone 済みの VM が存在する状況では、新たに容量を消費しないため
      // RAM ガードの再検証は行わない(cloneVm 自体を呼ばないので無関係)。
      const initial = creatingInstance({ id: "prov-resume-lowram", teamId: team1Id, index: 1, teamNumber: 1 })
      const proxmox = makeProxmoxPortTest({ existingVmids: [vmid1], freeMemBytes: 1_000_000_000 })
      const cloudflare = makeCloudflarePortTest()
      const layer = Layer.mergeAll(
        makeInstanceRepoTest([initial]),
        teamRepoLayer,
        githubKeysLayer,
        inviteRepoLayer,
        proxmox.layer,
        cloudflare.layer,
        ProvisioningConfigTest({ minFreeMemBytes: 5_000_000_000 })
      )

      const result = yield* runProvisioning(initial).pipe(Effect.provide(layer))

      expect(result.status).toBe("running")
      const px = yield* proxmox.getState
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
