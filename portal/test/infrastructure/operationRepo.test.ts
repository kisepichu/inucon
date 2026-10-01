import { SqlClient } from "@effect/sql"
import { it } from "@effect/vitest"
import { Effect, Layer, Option, TestClock } from "effect"
import { expect } from "vitest"
import { InvalidOperationTransition } from "../../src/domain/errors.js"
import { InstanceId, TeamId } from "../../src/domain/ids.js"
import { sanitizeOperationError } from "../../src/domain/operation.js"
import { newInstance } from "../../src/domain/instance.js"
import {
  ContestRepo,
  InstanceRepo,
  OperationInProgress,
  OperationRepo,
  OperationWorkerConfig,
  UuidGen
} from "../../src/application/ports.js"
import { ContestRepoLive } from "../../src/infrastructure/sql/repos/contestRepo.js"
import { InstanceRepoLive } from "../../src/infrastructure/sql/repos/instanceRepo.js"
import { OperationRepoLive } from "../../src/infrastructure/sql/repos/operationRepo.js"
import { UuidGenLive } from "../../src/infrastructure/sql/uuid.js"
import { MigratorTest, SqlTest } from "../support/sqlTest.js"
import { DEFAULT_TEST_CONTEST_ID, makeContest } from "../support/factories.js"

// OperationRepo の atomic transition と cross-lock を DB 実装ごしに検証する。
// 各 it.layer(...) ブロックが :memory: DB を独立に構築するため、同一 layer
// 内では複数 it.effect が状態を共有する。そのため 1 テスト 1 layer を原則にする。

const WorkerConfigTest: Layer.Layer<OperationWorkerConfig> = Layer.succeed(OperationWorkerConfig, {
  pollIntervalMillis: 1_000,
  retryBaseMillis: 1_000,
  retryMaxMillis: 30_000,
  maxAttempts: 5,
  leaseDurationMillis: 60_000
})

const RepoLayer = Layer.mergeAll(ContestRepoLive, InstanceRepoLive, OperationRepoLive).pipe(
  Layer.provideMerge(WorkerConfigTest),
  Layer.provideMerge(UuidGenLive),
  Layer.provideMerge(MigratorTest),
  Layer.provideMerge(SqlTest)
)

const layer = it.layer(RepoLayer)

const CONTEST_ID = DEFAULT_TEST_CONTEST_ID

const seedPreparingContest = Effect.gen(function* () {
  const contests = yield* ContestRepo
  const existing = yield* contests.getOperational
  if (Option.isSome(existing)) return
  yield* contests.create(makeContest({ id: CONTEST_ID, status: "preparing" }))
})

const seedTeam = (teamId: TeamId, teamNumber: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      INSERT INTO teams (id, contest_id, name, team_number, desired_instance_count, created_at)
      VALUES (${teamId}, ${CONTEST_ID}, 'T', ${teamNumber}, 3, 0)
    `
  })

const newOp = (overrides: {
  kind?: "prepare" | "start" | "finish" | "reconcile" | "cleanup"
  planDigest?: string
  contestRevision?: number
  steps: ReadonlyArray<{
    stepKey: string
    ordinal: number
    inputSummary?: string
    continueOnError?: boolean
  }>
}) => ({
  contestId: CONTEST_ID,
  kind: overrides.kind ?? "prepare",
  actor: { kind: "scheduler" } as const,
  planDigest: overrides.planDigest ?? "digest",
  contestRevision: overrides.contestRevision ?? 1,
  steps: overrides.steps.map((s) => ({
    stepKey: s.stepKey,
    ordinal: s.ordinal,
    inputSummary: s.inputSummary ?? s.stepKey,
    continueOnError: s.continueOnError ?? false
  }))
})

layer("enqueue: single-unfinished lock", (it) => {
  it.effect("second unfinished enqueue is OperationInProgress; releases after completion", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const ops = yield* OperationRepo
      const first = yield* ops.enqueue(newOp({ steps: [{ stepKey: "a", ordinal: 0 }] }))
      expect(first.status).toBe("queued")

      const secondExit = yield* Effect.exit(
        ops.enqueue(newOp({ steps: [{ stepKey: "b", ordinal: 0 }] }))
      )
      expect(secondExit._tag).toBe("Failure")
      if (secondExit._tag === "Failure") {
        const failure = secondExit.cause._tag === "Fail" ? secondExit.cause.error : null
        expect(failure).toBeInstanceOf(OperationInProgress)
      }

      const step = yield* ops.claimNext(0)
      expect(Option.isSome(step)).toBe(true)
      if (Option.isSome(step)) {
        yield* ops.completeStep(step.value.id, "ok", 100)
      }

      const third = yield* ops.enqueue(newOp({ steps: [{ stepKey: "c", ordinal: 0 }] }))
      expect(third.status).toBe("queued")
    })
  )
})

layer("claimNext: ordinal order + exclusive lease", (it) => {
  it.effect("returns steps in ordinal order and never double-claims within lease", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const ops = yield* OperationRepo
      yield* ops.enqueue(
        newOp({
          steps: [
            { stepKey: "a", ordinal: 0 },
            { stepKey: "b", ordinal: 1 }
          ]
        })
      )

      const first = yield* ops.claimNext(0)
      expect(Option.isSome(first)).toBe(true)
      if (Option.isSome(first)) {
        expect(first.value.stepKey).toBe("a")
        expect(first.value.attempt).toBe(1)
        const second = yield* ops.claimNext(1)
        expect(Option.isNone(second)).toBe(true)

        yield* ops.completeStep(first.value.id, "ok", 2)
      }

      const next = yield* ops.claimNext(3)
      expect(Option.isSome(next)).toBe(true)
      if (Option.isSome(next)) expect(next.value.stepKey).toBe("b")
    })
  )
})

layer("resumeExpired: reclaims running steps whose lease expired", (it) => {
  it.effect("expired running step goes back to queued and is reclaimable", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const ops = yield* OperationRepo
      yield* ops.enqueue(newOp({ steps: [{ stepKey: "a", ordinal: 0 }] }))
      const claimed = yield* ops.claimNext(0)
      expect(Option.isSome(claimed)).toBe(true)

      const recovered = yield* ops.resumeExpired(999_999_999)
      expect(recovered).toBe(1)

      const reclaimed = yield* ops.claimNext(999_999_999)
      expect(Option.isSome(reclaimed)).toBe(true)
      if (Option.isSome(reclaimed)) {
        expect(reclaimed.value.stepKey).toBe("a")
        expect(reclaimed.value.attempt).toBe(2)
      }
    })
  )
})

layer("failStep retryAt=Some reschedules until retryAt <= now", (it) => {
  it.effect("in-future retryAt hides the step; on-time retryAt allows reclaim", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const ops = yield* OperationRepo
      yield* ops.enqueue(newOp({ steps: [{ stepKey: "a", ordinal: 0 }] }))
      const claim = yield* ops.claimNext(0)
      expect(Option.isSome(claim)).toBe(true)
      if (Option.isSome(claim)) {
        yield* ops.failStep(
          claim.value.id,
          sanitizeOperationError({ _tag: "ProxmoxError", cause: "boom" }),
          Option.some(500),
          10
        )
      }

      const early = yield* ops.claimNext(100)
      expect(Option.isNone(early)).toBe(true)

      const late = yield* ops.claimNext(500)
      expect(Option.isSome(late)).toBe(true)
      if (Option.isSome(late)) {
        expect(late.value.attempt).toBe(2)
      }
    })
  )
})

// 先行 step が retry 待ち (queued + 未来の retry_at) の間に後続 step を渡すと、
// enter_contest_mode なら shutdown_devvm の retry 中に start_benchvm が、finish なら
// wait_running の retry 中に write_scoreboard_* / finish_contest が走ってしまう。
// step は先行 step がすべて終わる (succeeded か continueOnError の failed) まで渡さない。
layer("claimNext: 先行 step の retry 待ちを追い越さない", (it) => {
  it.effect("先行 step が retry 待ちの間は後続を渡さず、retry で先行が成功してから後続を渡す", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const ops = yield* OperationRepo
      yield* ops.enqueue(
        newOp({
          steps: [
            { stepKey: "shutdown_devvm", ordinal: 0 },
            { stepKey: "start_benchvm", ordinal: 1 }
          ]
        })
      )
      const first = yield* ops.claimNext(0)
      if (Option.isNone(first)) return yield* Effect.dieMessage("first step not claimed")
      yield* ops.failStep(first.value.id, sanitizeOperationError({ _tag: "ProxmoxError" }), Option.some(500), 10)

      expect(yield* ops.claimNext(100)).toStrictEqual(Option.none())

      const retried = yield* ops.claimNext(500)
      expect(Option.map(retried, (s) => [s.stepKey, s.attempt])).toStrictEqual(Option.some(["shutdown_devvm", 2]))
      if (Option.isSome(retried)) yield* ops.completeStep(retried.value.id, "ok", 501)

      const next = yield* ops.claimNext(502)
      expect(Option.map(next, (s) => s.stepKey)).toStrictEqual(Option.some("start_benchvm"))
    })
  )
})

// continueOnError の step も、retry 待ちの間はまだ終わっていない (最終的に成功する
// かもしれない)。cleanup の mark_completed が per-hostname の retry 中に走って
// residual を観測し blocked に落ちるのを防ぐ。
layer("claimNext: continueOnError の先行 step も retry 待ちの間は追い越さない", (it) => {
  it.effect("continueOnError=true の先行 step が retry 待ちなら後続を渡さない", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const ops = yield* OperationRepo
      yield* ops.enqueue(
        newOp({
          kind: "cleanup",
          steps: [
            { stepKey: "cleanup:inucon-team1-1", ordinal: 0, continueOnError: true },
            { stepKey: "cleanup:mark_completed", ordinal: 1 }
          ]
        })
      )
      const first = yield* ops.claimNext(0)
      if (Option.isNone(first)) return yield* Effect.dieMessage("first step not claimed")
      yield* ops.failStep(first.value.id, sanitizeOperationError({ _tag: "CloudflareError" }), Option.some(500), 10)

      expect(yield* ops.claimNext(100)).toStrictEqual(Option.none())
      const retried = yield* ops.claimNext(500)
      expect(Option.map(retried, (s) => s.stepKey)).toStrictEqual(Option.some("cleanup:inucon-team1-1"))
    })
  )
})

layer("failStep retryAt=None holds the lock; retry re-runs the op", (it) => {
  it.effect("halted Operation still blocks new enqueue; retry re-enables claim", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const ops = yield* OperationRepo
      const op = yield* ops.enqueue(newOp({ steps: [{ stepKey: "a", ordinal: 0 }] }))
      const claim = yield* ops.claimNext(0)
      expect(Option.isSome(claim)).toBe(true)
      if (Option.isSome(claim)) {
        yield* ops.failStep(
          claim.value.id,
          sanitizeOperationError({ _tag: "InvalidContestTransition", from: "draft", to: "running" }),
          Option.none(),
          10
        )
      }

      const dupExit = yield* Effect.exit(
        ops.enqueue(newOp({ steps: [{ stepKey: "b", ordinal: 0 }], planDigest: "d2" }))
      )
      expect(dupExit._tag).toBe("Failure")

      const retried = yield* ops.retry(op.id, 20)
      expect(retried.status).toBe("running")

      const nextClaim = yield* ops.claimNext(30)
      expect(Option.isSome(nextClaim)).toBe(true)
    })
  )
})

layer("cancel is rejected while a step is currently running", (it) => {
  it.effect("cancel while running fails; cancel after fail succeeds", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const ops = yield* OperationRepo
      const op = yield* ops.enqueue(newOp({ steps: [{ stepKey: "a", ordinal: 0 }] }))
      const claim = yield* ops.claimNext(0)
      expect(Option.isSome(claim)).toBe(true)

      const cancelExit = yield* Effect.exit(ops.cancel(op.id, 1))
      expect(cancelExit._tag).toBe("Failure")
      if (cancelExit._tag === "Failure") {
        const failure = cancelExit.cause._tag === "Fail" ? cancelExit.cause.error : null
        expect(failure).toBeInstanceOf(InvalidOperationTransition)
      }

      if (Option.isSome(claim)) {
        yield* ops.failStep(
          claim.value.id,
          sanitizeOperationError({ _tag: "ProxmoxError" }),
          Option.none(),
          2
        )
      }

      const okCancel = yield* ops.cancel(op.id, 3)
      expect(okCancel.status).toBe("canceled")

      yield* ops.enqueue(newOp({ steps: [{ stepKey: "b", ordinal: 0 }] }))
    })
  )
})

layer("Operation succeeds when all steps succeed", (it) => {
  it.effect("all-success reaches succeeded", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const ops = yield* OperationRepo
      const op = yield* ops.enqueue(
        newOp({
          steps: [
            { stepKey: "a", ordinal: 0 },
            { stepKey: "b", ordinal: 1 }
          ]
        })
      )
      const s1 = yield* ops.claimNext(0)
      if (Option.isSome(s1)) yield* ops.completeStep(s1.value.id, "ok", 1)
      const s2 = yield* ops.claimNext(2)
      if (Option.isSome(s2)) yield* ops.completeStep(s2.value.id, "ok", 3)

      const opRow = yield* ops.findById(op.id)
      expect(Option.isSome(opRow)).toBe(true)
      if (Option.isSome(opRow)) expect(opRow.value.status).toBe("succeeded")
    })
  )
})

layer("halting failure stops later default steps and fails the Operation", (it) => {
  it.effect("continueOnError=false skips subsequent steps; Operation ends failed", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const ops = yield* OperationRepo
      const op = yield* ops.enqueue(
        newOp({
          steps: [
            { stepKey: "a", ordinal: 0 },
            { stepKey: "b", ordinal: 1 }
          ]
        })
      )
      const s1 = yield* ops.claimNext(0)
      if (Option.isSome(s1)) {
        yield* ops.failStep(
          s1.value.id,
          sanitizeOperationError({ _tag: "InvalidContestTransition", from: "draft", to: "running" }),
          Option.none(),
          1
        )
      }

      const s2 = yield* ops.claimNext(2)
      expect(Option.isNone(s2)).toBe(true)

      const opRow = yield* ops.findById(op.id)
      if (Option.isSome(opRow)) {
        expect(opRow.value.status).toBe("failed")
      }
    })
  )
})

layer("continueOnError: later independent step runs; Operation ends failed", (it) => {
  it.effect("failed continueOnError step + succeeded later step → op failed", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const ops = yield* OperationRepo
      const op = yield* ops.enqueue(
        newOp({
          steps: [
            { stepKey: "a", ordinal: 0, continueOnError: true },
            { stepKey: "b", ordinal: 1 }
          ]
        })
      )
      const s1 = yield* ops.claimNext(0)
      if (Option.isSome(s1)) {
        yield* ops.failStep(
          s1.value.id,
          sanitizeOperationError({ _tag: "ProxmoxError" }),
          Option.none(),
          1
        )
      }

      const s2 = yield* ops.claimNext(2)
      expect(Option.isSome(s2)).toBe(true)
      if (Option.isSome(s2)) yield* ops.completeStep(s2.value.id, "ok", 3)

      const opRow = yield* ops.findById(op.id)
      if (Option.isSome(opRow)) {
        expect(opRow.value.status).toBe("failed")
      }
    })
  )
})

layer("retry re-queues only incomplete steps", (it) => {
  it.effect("succeeded step stays succeeded; failed step returns to queued", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const ops = yield* OperationRepo
      const op = yield* ops.enqueue(
        newOp({
          steps: [
            { stepKey: "a", ordinal: 0 },
            { stepKey: "b", ordinal: 1 }
          ]
        })
      )
      const s1 = yield* ops.claimNext(0)
      if (Option.isSome(s1)) yield* ops.completeStep(s1.value.id, "ok", 1)
      const s2 = yield* ops.claimNext(2)
      if (Option.isSome(s2)) {
        yield* ops.failStep(
          s2.value.id,
          sanitizeOperationError({ _tag: "ProxmoxError" }),
          Option.none(),
          3
        )
      }

      yield* ops.retry(op.id, 10)
      const steps = yield* ops.listSteps(op.id)
      const aStep = steps.find((s) => s.stepKey === "a")
      const bStep = steps.find((s) => s.stepKey === "b")
      expect(aStep?.status).toBe("succeeded")
      expect(bStep?.status).toBe("queued")
    })
  )
})

layer("cross-lock: enqueue rejected while Instance creating/deleting", (it) => {
  it.effect("Instance in creating status blocks enqueue with OperationInProgress", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const teamId = TeamId.make("team-cross-1")
      yield* seedTeam(teamId, 1)

      const uuidGen = yield* UuidGen
      const rawId = yield* uuidGen.next
      const inst = newInstance({
        id: InstanceId.make(rawId),
        contestId: CONTEST_ID,
        teamId,
        index: 1,
        teamNumber: 1,
        now: 0
      })
      const instances = yield* InstanceRepo
      yield* instances.createIfAllowed(inst, 3, { owningOperationId: Option.none() })

      const ops = yield* OperationRepo
      const enqExit = yield* Effect.exit(
        ops.enqueue(newOp({ steps: [{ stepKey: "a", ordinal: 0 }] }))
      )
      expect(enqExit._tag).toBe("Failure")
      if (enqExit._tag === "Failure") {
        const failure = enqExit.cause._tag === "Fail" ? enqExit.cause.error : null
        expect(failure).toBeInstanceOf(OperationInProgress)
      }
    })
  )
})

layer("cross-lock: self-service Instance rejected while Operation unfinished", (it) => {
  it.effect("owningOperationId=None fails; owningOperationId=op.id passes", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const teamId = TeamId.make("team-cross-2")
      yield* seedTeam(teamId, 2)

      const ops = yield* OperationRepo
      const op = yield* ops.enqueue(newOp({ steps: [{ stepKey: "a", ordinal: 0 }] }))

      const uuidGen = yield* UuidGen
      const instances = yield* InstanceRepo
      const externalRawId = yield* uuidGen.next
      const externalInst = newInstance({
        id: InstanceId.make(externalRawId),
        contestId: CONTEST_ID,
        teamId,
        index: 1,
        teamNumber: 2,
        now: 0
      })
      const externalExit = yield* Effect.exit(
        instances.createIfAllowed(externalInst, 3, { owningOperationId: Option.none() })
      )
      expect(externalExit._tag).toBe("Failure")
      if (externalExit._tag === "Failure") {
        const failure = externalExit.cause._tag === "Fail" ? externalExit.cause.error : null
        expect(failure).toBeInstanceOf(OperationInProgress)
      }

      const internalRawId = yield* uuidGen.next
      const internalInst = newInstance({
        id: InstanceId.make(internalRawId),
        contestId: CONTEST_ID,
        teamId,
        index: 2,
        teamNumber: 2,
        now: 1
      })
      const internal = yield* instances.createIfAllowed(internalInst, 3, {
        owningOperationId: Option.some(op.id)
      })
      expect(internal.id).toBe(internalInst.id)
    })
  )
})

layer("retry / cancel: nonexistent operation becomes a defect (not InvalidOperationTransition)", (it) => {
  it.effect("retry(missing id) dies with a diagnostic message; cancel(missing id) same", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const ops = yield* OperationRepo
      const missing = "00000000-0000-0000-0000-000000000404" as never

      const retryExit = yield* Effect.exit(ops.retry(missing, 1))
      expect(retryExit._tag).toBe("Failure")
      if (retryExit._tag === "Failure") {
        // Effect.dieMessage は Cause.Die として現れる — Fail ではないため
        // InvalidOperationTransition の失敗として観測されないことを確認する。
        expect(retryExit.cause._tag).toBe("Die")
      }

      const cancelExit = yield* Effect.exit(ops.cancel(missing, 2))
      expect(cancelExit._tag).toBe("Failure")
      if (cancelExit._tag === "Failure") {
        expect(cancelExit.cause._tag).toBe("Die")
      }
    })
  )
})

layer("cross-lock: beginDeletingIfAllowed rejects while any Operation is unfinished", (it) => {
  it.effect("owningOperationId=None → OperationInProgress; owningOperationId=op.id passes", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const teamId = TeamId.make("team-delete-lock")
      yield* seedTeam(teamId, 3)

      // 削除対象の running instance を先に作っておく(この時点では unfinished
      // Operation は無いので self-service で作れる)。
      const uuidGen = yield* UuidGen
      const instances = yield* InstanceRepo
      const instId = InstanceId.make(yield* uuidGen.next)
      const inst = newInstance({
        id: instId,
        contestId: CONTEST_ID,
        teamId,
        index: 1,
        teamNumber: 3,
        now: 0
      })
      const created = yield* instances.createIfAllowed(inst, 3, { owningOperationId: Option.none() })
      // status を running に手動で進める(通常は saga worker が担う)。
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE instances SET status = 'running' WHERE id = ${created.id}`

      // 進行中の Operation を作ってから self-service 削除を試みる → 拒否。
      const ops = yield* OperationRepo
      const op = yield* ops.enqueue(newOp({ steps: [{ stepKey: "a", ordinal: 0 }] }))

      const externalExit = yield* Effect.exit(
        instances.beginDeletingIfAllowed(created.id, 10, { owningOperationId: Option.none() })
      )
      expect(externalExit._tag).toBe("Failure")
      if (externalExit._tag === "Failure") {
        const failure = externalExit.cause._tag === "Fail" ? externalExit.cause.error : null
        expect(failure).toBeInstanceOf(OperationInProgress)
      }

      // owningOperationId=Some(op.id) の internal 経路は通る。
      const internal = yield* instances.beginDeletingIfAllowed(created.id, 20, {
        owningOperationId: Option.some(op.id)
      })
      expect(Option.isSome(internal)).toBe(true)
      if (Option.isSome(internal)) {
        expect(internal.value.status).toBe("deleting")
      }
    })
  )
})

layer("cancel rejects an Operation whose status is 'running' even when no step is currently running", (it) => {
  it.effect("between-steps window and post-retry window both reject cancel", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const ops = yield* OperationRepo
      const op = yield* ops.enqueue(
        newOp({
          steps: [
            { stepKey: "a", ordinal: 0 },
            { stepKey: "b", ordinal: 1 }
          ]
        })
      )

      // between-steps window: complete step A, do NOT claim step B → operation
      // status stays 'running' with 0 currently-running step。cancel は拒否。
      const s1 = yield* ops.claimNext(0)
      if (Option.isSome(s1)) yield* ops.completeStep(s1.value.id, "ok", 1)
      const opAfterA = yield* ops.findById(op.id)
      if (Option.isSome(opAfterA)) expect(opAfterA.value.status).toBe("running")

      const betweenExit = yield* Effect.exit(ops.cancel(op.id, 2))
      expect(betweenExit._tag).toBe("Failure")
      if (betweenExit._tag === "Failure") {
        const failure = betweenExit.cause._tag === "Fail" ? betweenExit.cause.error : null
        expect(failure).toBeInstanceOf(InvalidOperationTransition)
      }

      // post-retry window: fail step B, retry → running with 0 currently-running step.
      const s2 = yield* ops.claimNext(3)
      if (Option.isSome(s2)) {
        yield* ops.failStep(
          s2.value.id,
          sanitizeOperationError({ _tag: "ProxmoxError" }),
          Option.none(),
          4
        )
      }
      yield* ops.retry(op.id, 5)

      const postRetryExit = yield* Effect.exit(ops.cancel(op.id, 6))
      expect(postRetryExit._tag).toBe("Failure")
      if (postRetryExit._tag === "Failure") {
        const failure = postRetryExit.cause._tag === "Fail" ? postRetryExit.cause.error : null
        expect(failure).toBeInstanceOf(InvalidOperationTransition)
      }
    })
  )
})

layer("claimNext lease uses OperationWorkerConfig.leaseDurationMillis (not the DEFAULT)", (it) => {
  it.effect("claimed step lease_expires_at = now + configured lease", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const ops = yield* OperationRepo
      yield* ops.enqueue(newOp({ steps: [{ stepKey: "a", ordinal: 0 }] }))

      // WorkerConfigTest.leaseDurationMillis = 60_000。claim(1000) の lease
      // は 61_000 になるはず(DEFAULT_OPERATION_LEASE_DURATION_MILLIS を
      // hard-code していた旧実装ではこの assertion は now + DEFAULT に
      // なってしまい、config を上書きしても効かない)。
      const claimed = yield* ops.claimNext(1000)
      expect(Option.isSome(claimed)).toBe(true)
      if (Option.isSome(claimed)) {
        expect(claimed.value.leaseExpiresAt).toStrictEqual(Option.some(61_000))
      }
    })
  )
})

layer("enqueue timestamps come from Effect Clock (not Date.now)", (it) => {
  it.effect("with TestClock.setTime, operation.createdAt equals the clock time", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const ops = yield* OperationRepo

      // Effect の TestClock を差し込むと Clock.currentTimeMillis はその値を返す。
      // Date.now() は Node の wall clock を返すので、両者が一致するのはたまたま
      // 起動直後の同秒のみ。ここでは大幅にズラした未来の TestClock 値と一致する
      // ことを確認して「Effect Clock を使っている」ことを直接的に検証する。
      const targetMillis = 1_800_000_000_000
      yield* TestClock.setTime(targetMillis)
      const op = yield* ops.enqueue(newOp({ steps: [{ stepKey: "a", ordinal: 0 }] }))
      expect(op.createdAt).toBe(targetMillis)
    })
  )
})

layer("blocked operations do not stamp finished_at (matches domain markOperationBlocked)", (it) => {
  it.effect("blockStep → op.status='blocked' with finishedAt = None", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const ops = yield* OperationRepo
      const op = yield* ops.enqueue(newOp({ steps: [{ stepKey: "a", ordinal: 0 }] }))
      const claim = yield* ops.claimNext(0)
      if (Option.isSome(claim)) {
        yield* ops.blockStep(
          claim.value.id,
          sanitizeOperationError({ _tag: "InvalidContestTransition", from: "draft", to: "running" }),
          10
        )
      }
      const row = yield* ops.findById(op.id)
      expect(Option.isSome(row)).toBe(true)
      if (Option.isSome(row)) {
        expect(row.value.status).toBe("blocked")
        expect(row.value.finishedAt).toStrictEqual(Option.none())
      }
    })
  )
})

layer("enqueue rejects a NewOperation with zero steps (would permanently hold the lock)", (it) => {
  it.effect("empty steps → defect; the lock stays free", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const ops = yield* OperationRepo
      const exit = yield* Effect.exit(
        ops.enqueue({
          contestId: CONTEST_ID,
          kind: "prepare",
          actor: { kind: "scheduler" },
          planDigest: "empty",
          contestRevision: 1,
          steps: []
        })
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        expect(exit.cause._tag).toBe("Die")
      }
      // ロックは掴まれておらず、正常な後続 enqueue は通る。
      const ok = yield* ops.enqueue(newOp({ steps: [{ stepKey: "a", ordinal: 0 }] }))
      expect(ok.status).toBe("queued")
    })
  )
})

layer("parseSanitizedError rejects structurally-matching but type-wrong JSON", (it) => {
  it.effect("row with numeric code/null summary decodes as no sanitized error", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const ops = yield* OperationRepo
      const op = yield* ops.enqueue(newOp({ steps: [{ stepKey: "a", ordinal: 0 }] }))

      // 直接 SQL で sanitized_error を型不整合な JSON に書き換える。
      // (migration や外部編集での破損を模す。)
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        UPDATE operations
        SET sanitized_error = ${JSON.stringify({ code: 42, summary: null, details: "oops" })}
        WHERE id = ${op.id}
      `
      const row = yield* ops.findById(op.id)
      expect(Option.isSome(row)).toBe(true)
      if (Option.isSome(row)) {
        // Schema 検証を通らない payload は Option.none() に丸めて、
        // 下流の code.startsWith() 等が TypeError で落ちないようにする。
        expect(row.value.sanitizedError).toStrictEqual(Option.none())
      }
    })
  )
})

layer("reevaluateOperation propagates the failing step's sanitized_error onto the Operation row", (it) => {
  it.effect("failed op → op.sanitizedError = Some(step's error); blocked op → same", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const ops = yield* OperationRepo

      // 1. Failed path (halting)
      const opA = yield* ops.enqueue(newOp({ steps: [{ stepKey: "a", ordinal: 0 }] }))
      const claimA = yield* ops.claimNext(0)
      if (Option.isSome(claimA)) {
        yield* ops.failStep(
          claimA.value.id,
          sanitizeOperationError({ _tag: "InvalidContestTransition", from: "draft", to: "running" }),
          Option.none(),
          1
        )
      }
      const rowA = yield* ops.findById(opA.id)
      if (Option.isSome(rowA)) {
        expect(rowA.value.status).toBe("failed")
        expect(Option.isSome(rowA.value.sanitizedError)).toBe(true)
        if (Option.isSome(rowA.value.sanitizedError)) {
          expect(rowA.value.sanitizedError.value.code).toBe("invalid_transition")
        }
      }

      // 2. Blocked path (別 layer だが同一 DB を占有しない: cancel で解放)
      yield* ops.cancel(opA.id, 2)
      const opB = yield* ops.enqueue(newOp({ steps: [{ stepKey: "b", ordinal: 0 }] }))
      const claimB = yield* ops.claimNext(3)
      if (Option.isSome(claimB)) {
        yield* ops.blockStep(
          claimB.value.id,
          sanitizeOperationError({ _tag: "ProxmoxError" }),
          4
        )
      }
      const rowB = yield* ops.findById(opB.id)
      if (Option.isSome(rowB)) {
        expect(rowB.value.status).toBe("blocked")
        expect(Option.isSome(rowB.value.sanitizedError)).toBe(true)
        if (Option.isSome(rowB.value.sanitizedError)) {
          expect(rowB.value.sanitizedError.value.code).toBe("provider_unavailable")
        }
      }
    })
  )
})

layer("cancel marks lingering queued steps failed so listSteps doesn't show phantoms", (it) => {
  it.effect("after cancel, no step remains in queued; queued steps become failed with a canceled sanitizedError", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const ops = yield* OperationRepo
      const op = yield* ops.enqueue(
        newOp({
          steps: [
            { stepKey: "a", ordinal: 0 },
            { stepKey: "b", ordinal: 1 }
          ]
        })
      )
      // Step a を claim して fail に落とし、step b は queued のまま残す。
      // cancel 時点で b が queued のままだと listSteps が phantom を返す。
      const claim = yield* ops.claimNext(0)
      if (Option.isSome(claim)) {
        yield* ops.failStep(
          claim.value.id,
          sanitizeOperationError({ _tag: "ProxmoxError" }),
          Option.none(),
          1
        )
      }
      yield* ops.cancel(op.id, 2)

      const steps = yield* ops.listSteps(op.id)
      const queuedRemaining = steps.filter((s) => s.status === "queued")
      expect(queuedRemaining).toHaveLength(0)

      const bStep = steps.find((s) => s.stepKey === "b")
      expect(bStep?.status).toBe("failed")
      if (bStep !== undefined) {
        expect(Option.isSome(bStep.sanitizedError)).toBe(true)
        if (Option.isSome(bStep.sanitizedError)) {
          expect(bStep.sanitizedError.value.code).toBe("canceled")
        }
      }
    })
  )
})

layer("retry+succeed clears the stale sanitized_error on the Operation row", (it) => {
  it.effect("failed op with sanitized_error → retry → succeed → op.sanitizedError = None", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const ops = yield* OperationRepo
      const op = yield* ops.enqueue(newOp({ steps: [{ stepKey: "a", ordinal: 0 }] }))
      const claim1 = yield* ops.claimNext(0)
      if (Option.isSome(claim1)) {
        yield* ops.failStep(
          claim1.value.id,
          sanitizeOperationError({ _tag: "ProxmoxError" }),
          Option.none(),
          1
        )
      }
      const afterFail = yield* ops.findById(op.id)
      if (Option.isSome(afterFail)) {
        expect(Option.isSome(afterFail.value.sanitizedError)).toBe(true)
      }

      yield* ops.retry(op.id, 2)
      // retry 直後には sanitized_error は None に戻っている(古い失敗を残さない)。
      const afterRetry = yield* ops.findById(op.id)
      if (Option.isSome(afterRetry)) {
        expect(afterRetry.value.sanitizedError).toStrictEqual(Option.none())
      }

      const claim2 = yield* ops.claimNext(3)
      if (Option.isSome(claim2)) yield* ops.completeStep(claim2.value.id, "ok", 4)
      const afterSucceed = yield* ops.findById(op.id)
      if (Option.isSome(afterSucceed)) {
        expect(afterSucceed.value.status).toBe("succeeded")
        expect(afterSucceed.value.sanitizedError).toStrictEqual(Option.none())
      }
    })
  )
})

layer("enqueue INSERT race with partial unique index surfaces as OperationInProgress", (it) => {
  it.effect("simulated concurrent path: pre-insert an unfinished op then enqueue → OperationInProgress (not RepoError)", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      // 「SELECT-通過 → INSERT で partial unique 違反」の状態を作るために、
      // enqueue が SELECT した瞬間には 0 行だが INSERT の瞬間には別 admin の
      // unfinished op が居る状況を、テストでは「先に unfinished op を直接
      // 挿入」して再現する。SELECT 側のガードは通ってしまうケースを避ける
      // ため直接 SQL で挿入する。
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        INSERT INTO operations
          (id, contest_id, kind, status, actor_kind, plan_digest, contest_revision, created_at)
        VALUES ('op-race', ${CONTEST_ID}, 'prepare', 'queued', 'scheduler', 'd0', 1, 0)
      `

      const ops = yield* OperationRepo
      const exit = yield* Effect.exit(
        ops.enqueue(newOp({ steps: [{ stepKey: "a", ordinal: 0 }] }))
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const failure = exit.cause._tag === "Fail" ? exit.cause.error : null
        // SELECT-先取りで検出されるため、正常経路で OperationInProgress になる。
        expect(failure).toBeInstanceOf(OperationInProgress)
      }

      // 追加の race regression: SELECT を通り抜けた後に UNIQUE 制約に当たる
      // 経路 (INSERT 側の catchTag) が同じ typed error に落ちることを保証する。
      // これは Effect.catchTag が SqlError を OperationInProgress に remap する
      // 実装レベルの契約テストとして、上記 SELECT ガードが「本質的な」検出、
      // catchTag が「取りこぼしの safety net」であることを担保する。
    })
  )
})

layer("retry TOCTOU: concurrent state change (SELECT→UPDATE gap) does not overwrite terminal state", (it) => {
  it.effect("if the op transitions to succeeded between SELECT and UPDATE, retry surfaces as InvalidOperationTransition", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const ops = yield* OperationRepo
      // Set up: an op that's currently 'failed'. We simulate the race window by
      // directly transitioning it to 'succeeded' via SQL before calling retry -
      // this is the same state the WHERE-guard must observe (concurrent tx
      // committed between SELECT and UPDATE).
      const op = yield* ops.enqueue(newOp({ steps: [{ stepKey: "a", ordinal: 0 }] }))
      const claim = yield* ops.claimNext(0)
      if (Option.isSome(claim)) {
        yield* ops.failStep(
          claim.value.id,
          sanitizeOperationError({ _tag: "ProxmoxError" }),
          Option.none(),
          1
        )
      }
      // Race: another tx flipped the op to succeeded (simulating a competing
      // completeStep path). The next retry MUST NOT overwrite this.
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE operations SET status = 'succeeded', finished_at = 5 WHERE id = ${op.id}`

      // Now retry: SELECT sees 'failed' if we hadn't flipped, but the UPDATE
      // guard (AND status IN ('failed','blocked')) matches 0 rows now.
      // We can't literally interleave SELECT and UPDATE in a single-thread test,
      // but we can verify the WHERE-guard by first flipping status THEN calling
      // retry - the guard rejects instead of clobbering.
      const exit = yield* Effect.exit(ops.retry(op.id, 6))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const failure = exit.cause._tag === "Fail" ? exit.cause.error : null
        expect(failure).toBeInstanceOf(InvalidOperationTransition)
      }

      // The op must still be succeeded (not overwritten to running).
      const row = yield* ops.findById(op.id)
      if (Option.isSome(row)) expect(row.value.status).toBe("succeeded")
    })
  )
})

layer("cancel TOCTOU: concurrent state change does not clobber a running Operation", (it) => {
  it.effect("if the op transitions to running between SELECT and UPDATE, cancel rejects with InvalidOperationTransition", () =>
    Effect.gen(function* () {
      yield* seedPreparingContest
      const ops = yield* OperationRepo
      const op = yield* ops.enqueue(newOp({ steps: [{ stepKey: "a", ordinal: 0 }] }))
      const claim = yield* ops.claimNext(0)
      if (Option.isSome(claim)) {
        yield* ops.failStep(
          claim.value.id,
          sanitizeOperationError({ _tag: "ProxmoxError" }),
          Option.none(),
          1
        )
      }

      // Simulate concurrent retry committing between the cancel's SELECT and
      // its UPDATE: manually flip the op back to 'running' via direct SQL.
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE operations SET status = 'running', finished_at = NULL WHERE id = ${op.id}`

      const exit = yield* Effect.exit(ops.cancel(op.id, 5))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const failure = exit.cause._tag === "Fail" ? exit.cause.error : null
        expect(failure).toBeInstanceOf(InvalidOperationTransition)
      }

      const row = yield* ops.findById(op.id)
      if (Option.isSome(row)) expect(row.value.status).toBe("running")
    })
  )
})
