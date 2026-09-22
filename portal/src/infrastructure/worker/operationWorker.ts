import { Clock, Effect, Layer, Option, Schedule } from "effect"
import { sanitizeOperationError } from "../../domain/operation.js"
import type { OperationStep } from "../../domain/operation.js"
import {
  OperationExecutionError,
  OperationHandlerRegistry,
  OperationRepo,
  OperationWorkerConfig
} from "../../application/ports.js"

// Task 6: durable Operation ワーカーの 1 tick と Layer wiring。
//
// tick は以下を順に行う:
//   1. resumeExpired(now): lease 期限切れの running step を queued に戻す。
//   2. claimNext(now): 実行可能な次 Step を 1 件だけ atomic に取る。
//   3. registry.lookup(kind, stepKey): ハンドラが無ければ blockStep で固定
//      configuration_error を打つ。
//   4. handler.run(step): 実行結果に応じて completeStep / failStep(retryAt) /
//      blockStep のどれかを呼ぶ。retry の deadline は
//      min(retryMaxMillis, retryBaseMillis * 2 ** (attempt - 1)) で計算する。
//      handler が Effect の failure で落ちた場合は sanitizeOperationError を
//      通し、attempt < maxAttempts なら retry、それ以外なら blockStep(operator 判断)。
//
// この効果は「now を明示的に受ける」形で公開する。テスト側は now を差し込み、
// 本番の Layer は Clock.currentTimeMillis を渡す(下記 OperationWorkerLive)。
export const tickOperationWorker = (now: number) =>
  Effect.gen(function* () {
    const ops = yield* OperationRepo
    const registry = yield* OperationHandlerRegistry

    yield* ops.resumeExpired(now)

    const claimed = yield* ops.claimNext(now)
    if (Option.isNone(claimed)) return

    const step: OperationStep = claimed.value
    const opRow = yield* ops.findById(step.operationId)
    if (Option.isNone(opRow)) {
      // Operation 側が消えた: cascade delete 済みなので何もしない。
      return
    }
    const handler = registry.lookup(opRow.value.kind, step.stepKey)
    if (Option.isNone(handler)) {
      const err = {
        code: "configuration_error",
        summary: "no handler registered for step",
        details: { kind: opRow.value.kind, stepKey: step.stepKey }
      }
      yield* ops.blockStep(step.id, err, now)
      return
    }

    const config = yield* OperationWorkerConfig
    const outcome = yield* handler.value.run(step).pipe(
      Effect.catchTag("OperationExecutionError", (e: OperationExecutionError) =>
        Effect.succeed({
          status: "handler_error" as const,
          sanitized: sanitizeOperationError(e.cause)
        })
      )
    )

    if (outcome.status === "succeeded") {
      yield* ops.completeStep(step.id, outcome.summary, now)
      return
    }
    if (outcome.status === "retry") {
      yield* ops.failStep(
        step.id,
        { code: "retry_scheduled", summary: outcome.summary, details: {} },
        Option.some(outcome.retryAt),
        now
      )
      return
    }
    if (outcome.status === "blocked") {
      yield* ops.blockStep(
        step.id,
        { code: "blocked", summary: outcome.summary, details: {} },
        now
      )
      return
    }
    // handler_error: sanitizeOperationError の code に応じて自動 retry か block
    // を選ぶ。provider_unavailable / provider_timeout / storage_unavailable は
    // 一時故障として exponential backoff (base * 2 ** (attempt-1), max=retryMax)
    // でリトライ、attempt が maxAttempts を超えたら blockStep で operator 判断待ち。
    // それ以外(invalid_transition / conflict / not_found など)は即 blockStep。
    const isTransient =
      outcome.sanitized.code === "provider_unavailable" ||
      outcome.sanitized.code === "provider_timeout" ||
      outcome.sanitized.code === "storage_unavailable"
    if (isTransient && step.attempt < config.maxAttempts) {
      const backoff = Math.min(
        config.retryMaxMillis,
        config.retryBaseMillis * Math.pow(2, Math.max(0, step.attempt - 1))
      )
      yield* ops.failStep(step.id, outcome.sanitized, Option.some(now + backoff), now)
      return
    }
    yield* ops.blockStep(step.id, outcome.sanitized, now)
  })

// 常駐ワーカー Layer。TimeoutSweeperLive / ProvisionerLive と同型の
// scoped-forked ループ。tick 間隔は OperationWorkerConfig.pollIntervalMillis
// から取り、失敗 cause は catchAllCause で握って logError にする(生存性優先)。
export const OperationWorkerLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const config = yield* OperationWorkerConfig
    const tick = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      yield* tickOperationWorker(now)
    })
    yield* tick.pipe(
      Effect.catchAllCause(Effect.logError),
      Effect.repeat(Schedule.spaced(`${config.pollIntervalMillis} millis`)),
      Effect.forkScoped
    )
  })
)
