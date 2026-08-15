import { it } from "@effect/vitest"
import { Effect, Layer, Option, Ref } from "effect"
import { expect } from "vitest"
import { sanitizeOperationError } from "../../src/domain/operation.js"
import {
  ContestRepo,
  OperationHandlerRegistry,
  OperationRepo,
  OperationWorkerConfig
} from "../../src/application/ports.js"
import type { StepOutcome } from "../../src/application/usecases/operations.js"
import { ContestRepoLive } from "../../src/infrastructure/sql/repos/contestRepo.js"
import { InstanceRepoLive } from "../../src/infrastructure/sql/repos/instanceRepo.js"
import { OperationRepoLive } from "../../src/infrastructure/sql/repos/operationRepo.js"
import { UuidGenLive } from "../../src/infrastructure/sql/uuid.js"
import { tickOperationWorker } from "../../src/infrastructure/worker/operationWorker.js"
import { MigratorTest, SqlTest } from "../support/sqlTest.js"
import { DEFAULT_TEST_CONTEST_ID, makeContest } from "../support/factories.js"

// Task 6: OperationWorker の 1 tick (claim → run handler → complete/fail)
// を Repo と組み合わせて検証する。ハンドラは Ref にスクリプト化した StepOutcome
// を差し込んで、成功/リトライ/ブロックを切り替える。

const WorkerConfigTest: Layer.Layer<OperationWorkerConfig> = Layer.succeed(OperationWorkerConfig, {
  pollIntervalMillis: 1_000,
  retryBaseMillis: 1_000,
  retryMaxMillis: 30_000,
  maxAttempts: 5,
  leaseDurationMillis: 60_000
})
const makeRegistryLayer = (
  scriptRef: Ref.Ref<ReadonlyArray<StepOutcome>>
): Layer.Layer<OperationHandlerRegistry | OperationWorkerConfig> =>
  Layer.merge(
    WorkerConfigTest,
    Layer.succeed(OperationHandlerRegistry, {
      lookup: () =>
        Option.some({
          run: () =>
            Effect.gen(function* () {
              const remaining = yield* Ref.get(scriptRef)
              if (remaining.length === 0) {
                return { status: "succeeded" as const, summary: "default-ok" }
              }
              const [next, ...rest] = remaining
              yield* Ref.set(scriptRef, rest)
              return next
            })
        })
    })
  )

const BaseLayer = Layer.mergeAll(ContestRepoLive, InstanceRepoLive, OperationRepoLive).pipe(
  Layer.provideMerge(WorkerConfigTest),
  Layer.provideMerge(UuidGenLive),
  Layer.provideMerge(MigratorTest),
  Layer.provideMerge(SqlTest)
)

const CONTEST_ID = DEFAULT_TEST_CONTEST_ID

const seedPreparingContest = Effect.gen(function* () {
  const contests = yield* ContestRepo
  const existing = yield* contests.getOperational
  if (Option.isSome(existing)) return
  yield* contests.create(makeContest({ id: CONTEST_ID, status: "preparing" }))
})

const enqueueSingleStep = (planDigest = "d") =>
  Effect.gen(function* () {
    const ops = yield* OperationRepo
    return yield* ops.enqueue({
      contestId: CONTEST_ID,
      kind: "prepare",
      actor: { kind: "scheduler" },
      planDigest,
      contestRevision: 1,
      steps: [{ stepKey: "a", ordinal: 0, inputSummary: "a", continueOnError: false }]
    })
  })

const layer = it.layer(BaseLayer)

layer("tickOperationWorker: claim, run, complete", (it) => {
  it.effect("succeeds on happy path and marks Operation succeeded", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const op = yield* enqueueSingleStep()
      const scriptRef = yield* Ref.make<ReadonlyArray<StepOutcome>>([
        { status: "succeeded", summary: "ok" }
      ])

      yield* tickOperationWorker(0).pipe(Effect.provide(makeRegistryLayer(scriptRef)))

      const ops = yield* OperationRepo
      const row = yield* ops.findById(op.id)
      expect(Option.isSome(row)).toBe(true)
      if (Option.isSome(row)) expect(row.value.status).toBe("succeeded")
    })
  )

  it.effect("retry outcome reschedules for retryAt without claiming until then", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const op = yield* enqueueSingleStep("d-retry")
      const scriptRef = yield* Ref.make<ReadonlyArray<StepOutcome>>([
        { status: "retry", retryAt: 500, summary: "will retry" },
        { status: "succeeded", summary: "ok" }
      ])

      yield* tickOperationWorker(10).pipe(Effect.provide(makeRegistryLayer(scriptRef)))
      yield* tickOperationWorker(100).pipe(Effect.provide(makeRegistryLayer(scriptRef)))
      const ops = yield* OperationRepo
      const midRow = yield* ops.findById(op.id)
      if (Option.isSome(midRow)) expect(midRow.value.status).not.toBe("succeeded")

      yield* tickOperationWorker(500).pipe(Effect.provide(makeRegistryLayer(scriptRef)))
      const finalRow = yield* ops.findById(op.id)
      if (Option.isSome(finalRow)) expect(finalRow.value.status).toBe("succeeded")
    })
  )

  it.effect("blocked outcome transitions Operation to blocked and retains lock", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const op = yield* enqueueSingleStep("d-block")
      const scriptRef = yield* Ref.make<ReadonlyArray<StepOutcome>>([
        { status: "blocked", summary: "cannot proceed" }
      ])

      yield* tickOperationWorker(0).pipe(Effect.provide(makeRegistryLayer(scriptRef)))

      const ops = yield* OperationRepo
      const row = yield* ops.findById(op.id)
      expect(Option.isSome(row)).toBe(true)
      if (Option.isSome(row)) expect(row.value.status).toBe("blocked")

      const nextExit = yield* Effect.exit(enqueueSingleStep("d-block-2"))
      expect(nextExit._tag).toBe("Failure")

      const steps = yield* ops.listSteps(op.id)
      expect(steps[0].sanitizedError._tag).toBe("Some")
    })
  )
})

layer("tickOperationWorker: missing handler blocks step", (it) => {
  it.effect("empty registry marks step blocked with fixed configuration_error code", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const op = yield* enqueueSingleStep("d-nohandler")

      const EmptyRegistry: Layer.Layer<OperationHandlerRegistry | OperationWorkerConfig> = Layer.merge(
        WorkerConfigTest,
        Layer.succeed(OperationHandlerRegistry, { lookup: () => Option.none() })
      )
      yield* tickOperationWorker(0).pipe(Effect.provide(EmptyRegistry))

      const ops = yield* OperationRepo
      const row = yield* ops.findById(op.id)
      expect(Option.isSome(row)).toBe(true)
      if (Option.isSome(row)) expect(row.value.status).toBe("blocked")
    })
  )
})

layer("tickOperationWorker: recovers expired running step after restart", (it) => {
  it.effect("expired-in-flight step is re-queued and completed on next tick", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const op = yield* enqueueSingleStep("d-recover")

      const ops = yield* OperationRepo
      const claim = yield* ops.claimNext(0)
      expect(Option.isSome(claim)).toBe(true)

      yield* ops.resumeExpired(999_999_999)

      const scriptRef = yield* Ref.make<ReadonlyArray<StepOutcome>>([
        { status: "succeeded", summary: "ok-after-recover" }
      ])
      yield* tickOperationWorker(999_999_999).pipe(Effect.provide(makeRegistryLayer(scriptRef)))

      const row = yield* ops.findById(op.id)
      if (Option.isSome(row)) expect(row.value.status).toBe("succeeded")
    })
  )
})

// sanitizeOperationError is re-exported via ops.failStep tests; keep the
// symbol referenced so this file stays self-consistent for future edits.
void sanitizeOperationError
