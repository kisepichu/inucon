import { it } from "@effect/vitest"
import { Effect, Layer, Option, TestClock } from "effect"
import { describe, expect } from "vitest"
import { ContestId } from "../../src/domain/ids.js"
import {
  ContestRepo,
  OperationRepo,
  OperationWorkerConfig
} from "../../src/application/ports.js"
import { ContestRepoLive } from "../../src/infrastructure/sql/repos/contestRepo.js"
import { InstanceRepoLive } from "../../src/infrastructure/sql/repos/instanceRepo.js"
import { OperationRepoLive } from "../../src/infrastructure/sql/repos/operationRepo.js"
import { ResourceBindingRepoLive } from "../../src/infrastructure/sql/repos/resourceBindingRepo.js"
import { TeamRepoLive } from "../../src/infrastructure/sql/repos/teamRepo.js"
import { UuidGenLive } from "../../src/infrastructure/sql/uuid.js"
import { makeCloudflarePortTest, makeProxmoxPortTest } from "../support/inMemory.js"
import { tickContestScheduler } from "../../src/infrastructure/worker/contestScheduler.js"
import { MigratorTest, SqlTest } from "../support/sqlTest.js"
import { makeContest } from "../support/factories.js"

// Task 11 §Step 1: TestClock で scheduledEndAt 到達を模し、scheduler の 1 tick が
// running→finalizing 遷移 + finish Operation を「1 度だけ」enqueue することを
// 検証する。scheduler restart 後の 2 度目 tick では二重 enqueue しない
// (OperationInProgress で弾かれる)。
//
// it.effect ごとに :memory: DB は新しく作られるので、テスト間の contest
// レコードは干渉しない(SqlTest / MigratorTest は Layer inline provide のため)。

const workerConfig = { pollIntervalMillis: 1_000, retryBaseMillis: 1_000, retryMaxMillis: 30_000, maxAttempts: 5, leaseDurationMillis: 60_000 }
const WorkerConfigTest = Layer.succeed(OperationWorkerConfig, workerConfig)

// Task 12: tickContestScheduler now also needs InstanceRepo / TeamRepo /
// ResourceBindingRepo / Proxmox / Cloudflare ports because cleanup evaluation
// re-plans the reconciliation to size per-hostname steps. revoke_access alone
// touches only ContestRepo + OperationRepo, but the tick function unifies both
// branches under a single Effect, so all deps must be provided even when only
// finalize/revoke_access is under test.
const testLayer = Layer.mergeAll(
  ContestRepoLive,
  InstanceRepoLive,
  OperationRepoLive,
  ResourceBindingRepoLive,
  TeamRepoLive,
  makeProxmoxPortTest().layer,
  makeCloudflarePortTest().layer
).pipe(
  Layer.provideMerge(UuidGenLive),
  Layer.provideMerge(WorkerConfigTest),
  Layer.provideMerge(MigratorTest),
  Layer.provideMerge(SqlTest)
)

const runningContest = (id: ContestId, endAt: number, edition: number) =>
  makeContest({
    id,
    edition,
    status: "running",
    scheduledStartAt: Option.some(100),
    scheduledEndAt: Option.some(endAt),
    accessClosesAt: Option.some(endAt),
    startedAt: Option.some(100),
    revision: 1
  })

const CONTEST_ID = ContestId.make("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")

describe("tickContestScheduler", () => {
  it.effect("running Contest の endAt <= now なら finalizing に遷移し、finish Operation が enqueue される", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.create(runningContest(CONTEST_ID, 1000, 1))
      yield* TestClock.setTime(2000)
      const enqueued = yield* tickContestScheduler(2000)
      expect(enqueued).toBe(1)

      const c = yield* contests.findById(CONTEST_ID)
      expect(Option.isSome(c)).toBe(true)
      if (Option.isSome(c)) {
        expect(c.value.status).toBe("finalizing")
        expect(c.value.revision).toBe(2)
      }
      const ops = yield* OperationRepo
      expect(yield* ops.hasUnfinished).toBe(true)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("2 度目の tick は同じ Contest に対して二重 enqueue しない (OperationInProgress で skip)", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.create(runningContest(CONTEST_ID, 1000, 1))
      yield* TestClock.setTime(2000)
      yield* tickContestScheduler(2000)
      const enqueued = yield* tickContestScheduler(2500)
      expect(enqueued).toBe(0)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("endAt > now の Contest には遷移も enqueue もしない", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.create(runningContest(CONTEST_ID, 10_000, 1))
      const enqueued = yield* tickContestScheduler(500)
      expect(enqueued).toBe(0)
      const c = yield* contests.findById(CONTEST_ID)
      if (Option.isSome(c)) {
        expect(c.value.status).toBe("running")
      }
    }).pipe(Effect.provide(testLayer))
  )

  // Task 12 §Step 1: accessClosesAt <= now かつ accessClosedAt IS NULL の
  // finished Contest に対して revoke_access Operation を 1 度だけ enqueue する。
  // 2 度目 tick は同一 (contest, kind) の queued/running Operation を
  // hasUnfinishedByContestAndKind で検出して skip する。
  it.effect("finished Contest の accessClosesAt 到達で revoke_access Operation を 1 度だけ enqueue する", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.create(
        makeContest({
          id: CONTEST_ID,
          edition: 1,
          status: "finished",
          scheduledStartAt: Option.some(100),
          scheduledEndAt: Option.some(1000),
          accessClosesAt: Option.some(1500),
          startedAt: Option.some(100),
          finalizingAt: Option.some(1000),
          finishedAt: Option.some(1200),
          revision: 4
        })
      )
      yield* TestClock.setTime(2000)
      const enqueued1 = yield* tickContestScheduler(2000)
      expect(enqueued1).toBe(1)

      const ops = yield* OperationRepo
      const openRevokeAccess = yield* ops.hasUnfinishedByContestAndKind(
        CONTEST_ID,
        "revoke_access"
      )
      expect(openRevokeAccess).toBe(true)

      const enqueued2 = yield* tickContestScheduler(2100)
      expect(enqueued2).toBe(0)
    }).pipe(Effect.provide(testLayer))
  )

  // Task 12 §Step 3: 「finish が global operation lock を握っている間」の
  // revoke_access enqueue は OperationInProgress で skip され、finish 完了後の
  // 次 tick で成功する。ここでは既存の finish 経路 (scheduledEndAt = accessClosesAt)
  // をそのまま利用し、1 tick 目で finish がロックを掴んだあと 2 tick 目で
  // revoke_access が enqueue できないことを確認する。
  it.effect("finish が global lock を握っている間 revoke_access は skip されるが due 判定は残る", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      // scheduledEndAt = accessClosesAt = 1000 (default spec)。
      yield* contests.create(
        makeContest({
          id: CONTEST_ID,
          edition: 1,
          status: "running",
          scheduledStartAt: Option.some(100),
          scheduledEndAt: Option.some(1000),
          accessClosesAt: Option.some(1000),
          startedAt: Option.some(100),
          revision: 1
        })
      )
      yield* TestClock.setTime(2000)
      // 1 tick 目: finish enqueue 成功 → global lock 掴む。
      const enqueued1 = yield* tickContestScheduler(2000)
      expect(enqueued1).toBe(1)
      const ops = yield* OperationRepo
      const finishOpen = yield* ops.hasUnfinishedByContestAndKind(CONTEST_ID, "finish")
      expect(finishOpen).toBe(true)

      // 2 tick 目: accessClosesAt <= now だが finish が global lock を保持し、
      // enqueue は OperationInProgress で skip される。
      const enqueued2 = yield* tickContestScheduler(2100)
      expect(enqueued2).toBe(0)
      const revokeOpen = yield* ops.hasUnfinishedByContestAndKind(
        CONTEST_ID,
        "revoke_access"
      )
      expect(revokeOpen).toBe(false)
    }).pipe(Effect.provide(testLayer))
  )

  // review round 2 #1: revoke_access が未完了 (accessClosedAt IS NULL) な
  // うちは cleanup を積まない。順序 spec §Step 4 の強制 gate。
  it.effect("accessClosedAt が NULL のうちは cleanupAt 到達でも cleanup Operation を積まない", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.create(
        makeContest({
          id: CONTEST_ID,
          edition: 1,
          status: "finished",
          scheduledStartAt: Option.some(100),
          scheduledEndAt: Option.some(1000),
          accessClosesAt: Option.some(1000),
          cleanupAt: Option.some(1500),
          // 意図的に accessClosedAt を null にしたまま。
          accessClosedAt: Option.none(),
          finalizingAt: Option.some(1000),
          finishedAt: Option.some(1200),
          startedAt: Option.some(100),
          revision: 4
        })
      )
      yield* TestClock.setTime(2000)
      const enqueued = yield* tickContestScheduler(2000)
      // access close の revoke_access は積まれる (1 件)。cleanup は gate で skip。
      expect(enqueued).toBe(1)
      const ops = yield* OperationRepo
      expect(yield* ops.hasUnfinishedByContestAndKind(CONTEST_ID, "cleanup")).toBe(false)
      expect(yield* ops.hasUnfinishedByContestAndKind(CONTEST_ID, "revoke_access")).toBe(true)
    }).pipe(Effect.provide(testLayer))
  )

  // Task 12 §Step 4: cleanupAt <= now かつ cleanupCompletedAt IS NULL でも
  // 撤収対象 hostname が 0 件なら NothingToReconcile で skip し、Operation は
  // 積まない (二重 enqueue しないことを spec は要求)。
  it.effect("cleanupAt 到達でも target hostname 0 件なら cleanup Operation は積まない", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.create(
        makeContest({
          id: CONTEST_ID,
          edition: 1,
          status: "finished",
          scheduledStartAt: Option.some(100),
          scheduledEndAt: Option.some(1000),
          accessClosesAt: Option.some(1000),
          cleanupAt: Option.some(1500),
          accessClosedAt: Option.some(1200),
          finalizingAt: Option.some(1000),
          finishedAt: Option.some(1200),
          startedAt: Option.some(100),
          revision: 5
        })
      )
      yield* TestClock.setTime(2000)
      const enqueued = yield* tickContestScheduler(2000)
      expect(enqueued).toBe(0)
      const ops = yield* OperationRepo
      const cleanupOpen = yield* ops.hasUnfinishedByContestAndKind(CONTEST_ID, "cleanup")
      expect(cleanupOpen).toBe(false)
    }).pipe(Effect.provide(testLayer))
  )
})
