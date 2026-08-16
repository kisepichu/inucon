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
import { OperationRepoLive } from "../../src/infrastructure/sql/repos/operationRepo.js"
import { UuidGenLive } from "../../src/infrastructure/sql/uuid.js"
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

const testLayer = Layer.mergeAll(ContestRepoLive, OperationRepoLive).pipe(
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
})
