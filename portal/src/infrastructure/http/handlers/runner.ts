import { HttpApiBuilder } from "@effect/platform"
import { Effect, Option } from "effect"
import { api, InvalidJobTransition } from "shared"
import {
  pollNextRunnerJob,
  reportFinish as reportFinishUsecase,
  reportProgress as reportProgressUsecase
} from "../../../application/usecases/bench.js"

// partialScore(progress のペイロード)は BenchJob に永続化するフィールドが
// 無いため使わない(スペック §4: 進捗表示用の途中スコアはランナー側が保持し、
// ポータル側は logChunk の蓄積とハートビート(recordProgressIfRunning)のみ
// 行う)。
export const RunnerLive = HttpApiBuilder.group(api, "runner", (handlers) =>
  handlers
    .handle("pollJob", ({ payload }) =>
      pollNextRunnerJob({
        runnerId: payload.runnerId,
        revision: payload.revision,
        benchReady: payload.benchReady,
        healthSummary: payload.healthSummary
      }).pipe(
        Effect.map((job) => ({ job: Option.getOrNull(job) })),
        Effect.orDie
      )
    )
    .handle("reportProgress", ({ path, payload }) =>
      reportProgressUsecase({ jobId: path.id, logChunk: payload.logChunk }).pipe(
        Effect.asVoid,
        Effect.catchTag("InvalidJobTransition", (e) =>
          Effect.fail(new InvalidJobTransition({ jobId: e.jobId, from: e.from, action: e.action }))
        ),
        Effect.orDie
      )
    )
    .handle("reportFinish", ({ path, payload }) =>
      reportFinishUsecase({
        jobId: path.id,
        score: payload.score,
        passed: payload.passed,
        errorMessage: payload.errorMessage,
        logTail: payload.logTail
      }).pipe(
        Effect.asVoid,
        Effect.catchTag("InvalidJobTransition", (e) =>
          Effect.fail(new InvalidJobTransition({ jobId: e.jobId, from: e.from, action: e.action }))
        ),
        Effect.orDie
      )
    )
)
