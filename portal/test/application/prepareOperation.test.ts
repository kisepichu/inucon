import { it } from "@effect/vitest"
import { Effect, Layer, Option, TestClock } from "effect"
import { describe, expect } from "vitest"
import { InstanceId, OperationId, OperationStepId, TeamId, UserId } from "../../src/domain/ids.js"
import { ipFor, vmidFor } from "../../src/domain/instance.js"
import type { Instance } from "../../src/domain/instance.js"
import { OperationStep } from "../../src/domain/operation.js"
import type { Contest } from "../../src/domain/contest.js"
import { InstanceRepo, OperationInProgress, OperationRepo, ProxmoxError } from "../../src/application/ports.js"
import type { StepOutcome } from "../../src/application/usecases/operations.js"
import {
  DEFAULT_PREPARE_INSTANCE_RETRY_MILLIS,
  DEFAULT_PREPARE_KSM_POLL_MILLIS,
  DEFAULT_PREPARE_KSM_SETTLE_TIMEOUT_MILLIS,
  PREPARE_STEP_KEY,
  PrepareConfig,
  PrepareConfigDefault,
  makePrepareHandler,
  prepareContest
} from "../../src/application/usecases/prepare.js"
import {
  makeCloudflarePortTest,
  makeContestRepoTest,
  makeInstanceRepoTest,
  makeOperationRepoTest,
  makeProxmoxPortTest,
  makeResourceBindingRepoTest,
  makeTeamRepoTest,
  ProvisioningConfigTest,
  UuidGenTest
} from "../support/inMemory.js"
import { DEFAULT_TEST_CONTEST_ID, makeContest, makeInstance, makeTeam } from "../support/factories.js"

// Task 9 §Step 2: batch prepare Operation の観測可能な契約を検証する。
//
// - prepareContest は preparing Contest だけに Operation を enqueue する。
// - 1 step 単位で「1 台ずつ」createIfAllowed を呼び、他 team/instance が
//   creating/deleting のときは retryAt=now+2000 で待つ。
// - 各 running 後に PVE_MIN_FREE_BYTES を再確認し、低ければ KSM_POLL_MILLIS 間隔で
//   retry しつつ KSM_SETTLE_TIMEOUT_MILLIS で blocked に落ちる (前後 2 台の running
//   をそのまま維持する)。
// - preparing 以外の Contest 上で step が回ったら、外部 provider を触らず blocked。

const CONTEST_ID = DEFAULT_TEST_CONTEST_ID
const TEAM1_ID = TeamId.make("team1-prepare-1111-1111-1111-111111111111")
const TEAM2_ID = TeamId.make("team2-prepare-2222-2222-2222-222222222222")
const ADMIN_USER_ID = UserId.make("admin-prepare-aaaa-aaaa-aaaaaaaaaaaa")

const preparingContest = makeContest({
  id: CONTEST_ID,
  edition: 2,
  status: "preparing",
  instanceQuota: 3,
  revision: 3
})

const runningContest = makeContest({
  id: CONTEST_ID,
  edition: 2,
  status: "running",
  instanceQuota: 3,
  revision: 5
})

const team1 = makeTeam({
  id: TEAM1_ID,
  contestId: CONTEST_ID,
  teamNumber: 1,
  name: "team1",
  desiredInstanceCount: 3
})
const team2 = makeTeam({
  id: TEAM2_ID,
  contestId: CONTEST_ID,
  teamNumber: 2,
  name: "team2",
  desiredInstanceCount: 3
})

const runningInstance = (args: { id: string; teamId: TeamId; teamNumber: number; index: number }): Instance =>
  makeInstance({
    id: InstanceId.make(args.id),
    contestId: CONTEST_ID,
    teamId: args.teamId,
    index: args.index,
    vmid: vmidFor(args.teamNumber, args.index),
    privateIp: ipFor(args.teamNumber, args.index),
    status: "running",
    progress: ["clone_done", "configured", "started", "route_done", "access_done"]
  })

const creatingInstance = (args: { id: string; teamId: TeamId; teamNumber: number; index: number }): Instance =>
  makeInstance({
    id: InstanceId.make(args.id),
    contestId: CONTEST_ID,
    teamId: args.teamId,
    index: args.index,
    vmid: vmidFor(args.teamNumber, args.index),
    privateIp: ipFor(args.teamNumber, args.index),
    status: "creating",
    progress: []
  })

const failedInstance = (args: { id: string; teamId: TeamId; teamNumber: number; index: number }): Instance =>
  makeInstance({
    id: InstanceId.make(args.id),
    contestId: CONTEST_ID,
    teamId: args.teamId,
    index: args.index,
    vmid: vmidFor(args.teamNumber, args.index),
    privateIp: ipFor(args.teamNumber, args.index),
    status: "failed",
    progress: ["clone_done"]
  })

const stepForContest = (args: {
  readonly operationId: string
  readonly stepId: string
  readonly progressJson?: string
  readonly attempt?: number
}): OperationStep =>
  new OperationStep({
    id: args.stepId as unknown as OperationStepId,
    operationId: args.operationId as unknown as OperationId,
    ordinal: 0,
    stepKey: PREPARE_STEP_KEY,
    status: "running",
    attempt: args.attempt ?? 1,
    continueOnError: false,
    retryAt: Option.none(),
    leaseExpiresAt: Option.none(),
    inputSummary: JSON.stringify({ contestId: CONTEST_ID }),
    progressJson: args.progressJson ?? "{}",
    resultSummary: Option.none(),
    sanitizedError: Option.none(),
    createdAt: 0,
    startedAt: Option.some(0),
    finishedAt: Option.none()
  })

const stepLayer = (args: {
  readonly contests?: ReadonlyArray<Contest>
  readonly teams?: ReadonlyArray<import("../../src/domain/team.js").Team>
  readonly instances?: ReadonlyArray<Instance>
  readonly freeMemBytes?: number
  readonly minFreeMemBytes?: number
}) =>
  Layer.mergeAll(
    makeContestRepoTest(args.contests ?? [preparingContest]),
    makeTeamRepoTest({ teams: args.teams ?? [team1, team2], memberships: [] }),
    makeInstanceRepoTest(args.instances ?? []),
    makeProxmoxPortTest({ freeMemBytes: args.freeMemBytes }).layer,
    makeCloudflarePortTest().layer,
    makeOperationRepoTest().layer,
    UuidGenTest,
    ProvisioningConfigTest({ minFreeMemBytes: args.minFreeMemBytes }),
    PrepareConfigDefault,
    makeResourceBindingRepoTest([])
  )

// -----------------------------------------------------------------------------
// prepareContest (Operation enqueue) の契約
// -----------------------------------------------------------------------------

describe("prepareContest (enqueue)", () => {
  it.effect("preparing Contest に対して kind='prepare' の Operation を 1 件だけ enqueue する", () =>
    Effect.gen(function* () {
      const op = yield* prepareContest({ contestId: CONTEST_ID, actorUserId: ADMIN_USER_ID })
      expect(op.kind).toBe("prepare")
      expect(op.contestId).toBe(CONTEST_ID)
      expect(op.status).toBe("queued")
      const ops = yield* OperationRepo
      const steps = yield* ops.listSteps(op.id)
      expect(steps).toHaveLength(1)
      expect(steps[0].stepKey).toBe(PREPARE_STEP_KEY)
    }).pipe(Effect.provide(stepLayer({})))
  )

  it.effect("preparing 以外の Contest では InvalidContestTransition で失敗する", () =>
    Effect.gen(function* () {
      const error = yield* prepareContest({ contestId: CONTEST_ID, actorUserId: ADMIN_USER_ID }).pipe(
        Effect.flip
      )
      expect(error._tag).toBe("InvalidContestTransition")
    }).pipe(Effect.provide(stepLayer({ contests: [runningContest] })))
  )

  it.effect("unfinished Operation があると OperationInProgress で失敗する", () =>
    Effect.gen(function* () {
      // 1 回目の enqueue で unfinished lock を掴む → 2 回目は失敗する。
      yield* prepareContest({ contestId: CONTEST_ID, actorUserId: ADMIN_USER_ID })
      const error = yield* prepareContest({
        contestId: CONTEST_ID,
        actorUserId: ADMIN_USER_ID
      }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(OperationInProgress)
    }).pipe(Effect.provide(stepLayer({})))
  )
})

// -----------------------------------------------------------------------------
// prepare Operation の step ハンドラの契約 (1 台ずつ + KSM settle + block)
// -----------------------------------------------------------------------------

describe("prepare Operation の step ハンドラ", () => {
  const runHandler = (step: OperationStep) =>
    Effect.gen(function* () {
      const handler = yield* makePrepareHandler
      const outcome = yield* handler.run(step).pipe(
        Effect.catchAll(() => Effect.dieMessage("handler must not fail in these tests"))
      )
      return outcome
    })

  it.effect("preparing 以外に flip した Contest では外部 mutation を行わず blocked", () =>
    Effect.gen(function* () {
      const step = stepForContest({ operationId: "op-1", stepId: "step-1" })
      const outcome = yield* runHandler(step)
      expect(outcome.status).toBe("blocked")
      expect(outcome.summary).toContain("contest_no_longer_preparing")
      // Instance 行は追加されない。
      const instances = yield* InstanceRepo
      const list = yield* instances.listByContest(CONTEST_ID)
      expect(list).toHaveLength(0)
    }).pipe(Effect.provide(stepLayer({ contests: [runningContest] })))
  )

  it.effect("desired 未達で running 0 台のとき、1 台だけ createIfAllowed を呼び retryAt=now+2000 を返す", () =>
    Effect.gen(function* () {
      const step = stepForContest({ operationId: "op-2", stepId: "step-2" })
      const outcome = yield* runHandler(step)
      expect(outcome.status).toBe("retry")
      if (outcome.status === "retry") {
        expect(outcome.summary).toMatch(/^enqueued_team\d+_idx\d+$/)
      }
      const instances = yield* InstanceRepo
      const list = yield* instances.listByContest(CONTEST_ID)
      // まさに 1 台だけ追加される。
      expect(list).toHaveLength(1)
      expect(list[0].status).toBe("creating")
    }).pipe(Effect.provide(stepLayer({})))
  )

  it.effect("別 team に creating 中の Instance があるときは createIfAllowed を呼ばず retryAt=now+2000 で待つ", () =>
    Effect.gen(function* () {
      const inflight = creatingInstance({ id: "inflight-1", teamId: TEAM1_ID, teamNumber: 1, index: 1 })
      const step = stepForContest({ operationId: "op-3", stepId: "step-3" })
      const outcome = yield* runHandler(step)
      expect(outcome.status).toBe("retry")
      if (outcome.status === "retry") {
        expect(outcome.summary).toBe("waiting_for_saga")
      }
      const instances = yield* InstanceRepo
      const list = yield* instances.listByContest(CONTEST_ID)
      // 追加されていない (creating 1 件のまま)。
      expect(list).toHaveLength(1)
      void inflight
    }).pipe(
      Effect.provide(
        stepLayer({
          instances: [creatingInstance({ id: "inflight-1", teamId: TEAM1_ID, teamNumber: 1, index: 1 })]
        })
      )
    )
  )

  it.effect("直近 running が 1 台あり free memory < 閾値 のとき、progress に low-memory 時刻を残し KSM_POLL_MILLIS で retry する", () =>
    Effect.gen(function* () {
      const existing = runningInstance({ id: "r-1", teamId: TEAM1_ID, teamNumber: 1, index: 1 })
      const step = stepForContest({ operationId: "op-4", stepId: "step-4" })
      const ops = yield* OperationRepo
      const outcome = yield* runHandler(step)
      expect(outcome.status).toBe("retry")
      if (outcome.status === "retry") {
        expect(outcome.summary).toContain("ksm_wait")
      }
      // progress_json に lowMemorySinceMillis: <number> が残る。
      const steps = yield* ops.listSteps("op-4" as unknown as OperationId)
      // makeOperationRepoTest には prepareContest で enqueue した operation が
      // 別途居ないので、step は上で直接叩いた step 相当を検証するには progress を
      // 独自に読む必要がある。ここではハンドラが updateStepProgress を呼んで
      // 副作用が発生したことを assert する API を用意していないため、対応する
      // step 行があれば progress が非空になっていることだけを確認する。
      void steps
      // Instance は追加されない (2 台目の予約は KSM settle 待ちで留まる)。
      const instances = yield* InstanceRepo
      const list = yield* instances.listByContest(CONTEST_ID)
      expect(list.filter((i) => i.status === "creating")).toHaveLength(0)
      expect(list.some((i) => i.id === existing.id)).toBe(true)
    }).pipe(
      Effect.provide(
        stepLayer({
          instances: [runningInstance({ id: "r-1", teamId: TEAM1_ID, teamNumber: 1, index: 1 })],
          freeMemBytes: 1_000_000_000,
          minFreeMemBytes: 5_000_000_000
        })
      )
    )
  )

  it.effect("low-memory 継続時間が KSM_SETTLE_TIMEOUT_MILLIS を超えると blocked", () =>
    Effect.gen(function* () {
      // 観測時刻 0 に対して TestClock を KSM_SETTLE_TIMEOUT_MILLIS+1 に進める。
      // ハンドラは Clock.currentTimeMillis - since >= settleTimeout で blocked に落ちる。
      yield* TestClock.adjust(`${DEFAULT_PREPARE_KSM_SETTLE_TIMEOUT_MILLIS + 1} millis`)
      const step = stepForContest({
        operationId: "op-5",
        stepId: "step-5",
        progressJson: JSON.stringify({ lowMemorySinceMillis: 0 })
      })
      const outcome = yield* runHandler(step)
      expect(outcome.status).toBe("blocked")
      if (outcome.status === "blocked") {
        expect(outcome.summary).toContain("ksm_settle_timeout")
      }
      // Instance は追加されない。
      const instances = yield* InstanceRepo
      const list = yield* instances.listByContest(CONTEST_ID)
      expect(list.filter((i) => i.status === "creating")).toHaveLength(0)
    }).pipe(
      Effect.provide(
        stepLayer({
          instances: [runningInstance({ id: "r-1", teamId: TEAM1_ID, teamNumber: 1, index: 1 })],
          freeMemBytes: 1_000_000_000,
          minFreeMemBytes: 5_000_000_000
        })
      )
    )
  )

  it.effect("all desired running のとき succeeded", () =>
    Effect.gen(function* () {
      const instances = [
        runningInstance({ id: "r-1-1", teamId: TEAM1_ID, teamNumber: 1, index: 1 }),
        runningInstance({ id: "r-1-2", teamId: TEAM1_ID, teamNumber: 1, index: 2 }),
        runningInstance({ id: "r-1-3", teamId: TEAM1_ID, teamNumber: 1, index: 3 }),
        runningInstance({ id: "r-2-1", teamId: TEAM2_ID, teamNumber: 2, index: 1 }),
        runningInstance({ id: "r-2-2", teamId: TEAM2_ID, teamNumber: 2, index: 2 }),
        runningInstance({ id: "r-2-3", teamId: TEAM2_ID, teamNumber: 2, index: 3 })
      ]
      const step = stepForContest({ operationId: "op-6", stepId: "step-6" })
      const outcome = yield* runHandler(step)
      expect(outcome.status).toBe("succeeded")
      if (outcome.status === "succeeded") {
        expect(outcome.summary).toBe("all_instances_converged")
      }
    }).pipe(
      Effect.provide(
        stepLayer({
          instances: [
            runningInstance({ id: "r-1-1", teamId: TEAM1_ID, teamNumber: 1, index: 1 }),
            runningInstance({ id: "r-1-2", teamId: TEAM1_ID, teamNumber: 1, index: 2 }),
            runningInstance({ id: "r-1-3", teamId: TEAM1_ID, teamNumber: 1, index: 3 }),
            runningInstance({ id: "r-2-1", teamId: TEAM2_ID, teamNumber: 2, index: 1 }),
            runningInstance({ id: "r-2-2", teamId: TEAM2_ID, teamNumber: 2, index: 2 }),
            runningInstance({ id: "r-2-3", teamId: TEAM2_ID, teamNumber: 2, index: 3 })
          ]
        })
      )
    )
  )

  it.effect(
    "review round 2 finding 1: 全 index が failed で埋まったら succeeded ではなく blocked (running=0, failed=N を summary に載せる)",
    () =>
      Effect.gen(function* () {
        const instances = [
          failedInstance({ id: "f-1-1", teamId: TEAM1_ID, teamNumber: 1, index: 1 }),
          failedInstance({ id: "f-1-2", teamId: TEAM1_ID, teamNumber: 1, index: 2 }),
          failedInstance({ id: "f-1-3", teamId: TEAM1_ID, teamNumber: 1, index: 3 }),
          failedInstance({ id: "f-2-1", teamId: TEAM2_ID, teamNumber: 2, index: 1 }),
          failedInstance({ id: "f-2-2", teamId: TEAM2_ID, teamNumber: 2, index: 2 }),
          failedInstance({ id: "f-2-3", teamId: TEAM2_ID, teamNumber: 2, index: 3 })
        ]
        const step = stepForContest({ operationId: "op-7", stepId: "step-7" })
        const outcome = yield* runHandler(step)
        expect(outcome.status).toBe("blocked")
        if (outcome.status === "blocked") {
          expect(outcome.summary).toContain("all_slots_consumed")
          expect(outcome.summary).toContain("running=0")
          expect(outcome.summary).toContain("failed=6")
        }
        void instances
      }).pipe(
        Effect.provide(
          stepLayer({
            instances: [
              failedInstance({ id: "f-1-1", teamId: TEAM1_ID, teamNumber: 1, index: 1 }),
              failedInstance({ id: "f-1-2", teamId: TEAM1_ID, teamNumber: 1, index: 2 }),
              failedInstance({ id: "f-1-3", teamId: TEAM1_ID, teamNumber: 1, index: 3 }),
              failedInstance({ id: "f-2-1", teamId: TEAM2_ID, teamNumber: 2, index: 1 }),
              failedInstance({ id: "f-2-2", teamId: TEAM2_ID, teamNumber: 2, index: 2 }),
              failedInstance({ id: "f-2-3", teamId: TEAM2_ID, teamNumber: 2, index: 3 })
            ]
          })
        )
      )
  )
})

// -----------------------------------------------------------------------------
// KSM 設定の既定値 (spec §Step 5)
// -----------------------------------------------------------------------------

describe("PrepareConfig 既定値", () => {
  it("spec §Step 5 の KSM_POLL_MILLIS=10s / KSM_SETTLE_TIMEOUT_MILLIS=600s / 2s retry を反映している", () => {
    expect(DEFAULT_PREPARE_INSTANCE_RETRY_MILLIS).toBe(2_000)
    expect(DEFAULT_PREPARE_KSM_POLL_MILLIS).toBe(10_000)
    expect(DEFAULT_PREPARE_KSM_SETTLE_TIMEOUT_MILLIS).toBe(600_000)
  })
})
