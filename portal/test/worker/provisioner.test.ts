import { it } from "@effect/vitest"
import { Effect, Layer, Option, TestClock } from "effect"
import { describe, expect } from "vitest"
import { InstanceId, TeamId, UserId } from "../../src/domain/ids.js"
import { Instance, ipFor, vmidFor } from "../../src/domain/instance.js"
import { Team } from "../../src/domain/team.js"
import { User } from "../../src/domain/user.js"
import { InstanceRepo } from "../../src/application/ports.js"
import { ProvisionerLive } from "../../src/infrastructure/worker/provisioner.js"
import {
  makeCloudflarePortTest,
  makeGithubKeysPortTest,
  makeInstanceRepoTest,
  makeProxmoxPortTest,
  makeTeamRepoTest,
  ProvisioningConfigTest
} from "../support/inMemory.js"

// ProvisionerLive は「Layer として動く」ことが要点(TimeoutSweeper と同型):
// 2 秒ごとに creating/deleting の instance を 1 件拾って saga を進める。ここでは
// (1) 常駐ワーカーとして creating を running まで進めること、(2) 全体で同時
// 1 インスタンスのみ(1 tick = 1 件)処理する排他を確認する。saga 自体の分岐
// (補償・再開・冪等)は test/application/provisioning.test.ts でカバー済み。

const team1Id = TeamId.make("11111111-1111-1111-1111-111111111111")
const team2Id = TeamId.make("22222222-2222-2222-2222-222222222222")
const aliceId = UserId.make("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
const carolId = UserId.make("cccccccc-cccc-cccc-cccc-cccccccccccc")

const team1 = new Team({ id: team1Id, name: "team1", teamNumber: 1 })
const team2 = new Team({ id: team2Id, name: "team2", teamNumber: 2 })
const alice = new User({
  id: aliceId,
  githubId: 1,
  githubLogin: "alice",
  displayName: "Alice",
  isAdmin: false,
  email: Option.some("alice@example.com")
})
const carol = new User({
  id: carolId,
  githubId: 3,
  githubLogin: "carol",
  displayName: "Carol",
  isAdmin: false,
  email: Option.some("carol@example.com")
})

const teamRepoLayer = makeTeamRepoTest({
  teams: [team1, team2],
  memberships: [
    { userId: aliceId, teamId: team1Id },
    { userId: carolId, teamId: team2Id }
  ],
  users: [alice, carol]
})

const githubKeysLayer = makeGithubKeysPortTest({
  alice: ["ssh-ed25519 AAAA alice@host"],
  carol: ["ssh-ed25519 CCCC carol@host"]
})

const creating = (args: { id: string; teamId: TeamId; index: number; teamNumber: number; createdAt: number }) =>
  new Instance({
    id: InstanceId.make(args.id),
    teamId: args.teamId,
    index: args.index,
    vmid: vmidFor(args.teamNumber, args.index),
    privateIp: ipFor(args.teamNumber, args.index),
    status: "creating",
    progress: [],
    errorMessage: Option.none(),
    createdAt: args.createdAt,
    updatedAt: args.createdAt
  })

const workerWith = (instances: ReadonlyArray<Instance>) => {
  const instanceRepo = makeInstanceRepoTest(instances)
  const deps = Layer.mergeAll(
    instanceRepo,
    teamRepoLayer,
    githubKeysLayer,
    makeProxmoxPortTest().layer,
    makeCloudflarePortTest().layer,
    ProvisioningConfigTest()
  )
  const worker = ProvisionerLive.pipe(Layer.provide(deps))
  // deps を worker とテスト本体の両方へ同一参照で渡す(timeoutSweeper.test.ts
  // と同じ理屈: 1 回の Effect.provide の MemoMap 内で Layer は 1 度だけ構築
  // されるため InstanceRepo の状態が共有される)。
  return Layer.mergeAll(worker, deps)
}

describe("ProvisionerLive", () => {
  it.effect("creating の instance を running まで進める", () =>
    Effect.gen(function* () {
      const inst = creating({ id: "w-1", teamId: team1Id, index: 1, teamNumber: 1, createdAt: 0 })
      yield* Effect.gen(function* () {
        // fork 直後の即時実行を走らせる(1ms では 2 秒の sleep は起きない)。
        yield* TestClock.adjust("1 millis")
        const repo = yield* InstanceRepo
        const stored = yield* repo.findById(inst.id)
        expect(Option.getOrThrow(stored).status).toBe("running")
      }).pipe(Effect.provide(workerWith([inst])))
    })
  )

  it.effect("全体で同時 1 件のみ: 2 件 creating でも 1 tick で 1 件ずつ進む", () =>
    Effect.gen(function* () {
      // createdAt 昇順で古い方(team1)が先に拾われる。
      const older = creating({ id: "w-old", teamId: team1Id, index: 1, teamNumber: 1, createdAt: 0 })
      const newer = creating({ id: "w-new", teamId: team2Id, index: 1, teamNumber: 2, createdAt: 100 })

      yield* Effect.gen(function* () {
        const repo = yield* InstanceRepo

        // fork 直後の即時実行だけ走らせる(sleep 2 秒には満たない)。この時点で
        // 進むのは古い方 1 件のみ、新しい方はまだ creating のまま = 排他。
        yield* TestClock.adjust("1 millis")
        const olderAfter1 = yield* repo.findById(older.id)
        const newerAfter1 = yield* repo.findById(newer.id)
        expect(Option.getOrThrow(olderAfter1).status).toBe("running")
        expect(Option.getOrThrow(newerAfter1).status).toBe("creating")

        // 次の周期(2 秒)で 2 件目が進む。
        yield* TestClock.adjust("2 seconds")
        const newerAfter2 = yield* repo.findById(newer.id)
        expect(Option.getOrThrow(newerAfter2).status).toBe("running")
      }).pipe(Effect.provide(workerWith([older, newer])))
    })
  )

  it.effect("deleting の instance を deleted まで進める", () =>
    Effect.gen(function* () {
      const inst = new Instance({
        id: InstanceId.make("w-del"),
        teamId: team1Id,
        index: 1,
        vmid: vmidFor(1, 1),
        privateIp: ipFor(1, 1),
        status: "deleting",
        progress: ["clone_done", "configured", "started", "route_done", "access_done"],
        errorMessage: Option.none(),
        createdAt: 0,
        updatedAt: 0
      })
      yield* Effect.gen(function* () {
        yield* TestClock.adjust("1 millis")
        const repo = yield* InstanceRepo
        const stored = yield* repo.findById(inst.id)
        expect(Option.getOrThrow(stored).status).toBe("deleted")
      }).pipe(Effect.provide(workerWith([inst])))
    })
  )
})
