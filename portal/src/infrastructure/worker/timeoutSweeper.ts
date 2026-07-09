import { Effect, Layer, Schedule } from "effect"
import { sweepTimedOutJobs } from "../../application/usecases/bench.js"

// 10 分(JOB_TIMEOUT_MILLIS)無進捗の running ジョブを failed 化するバック
// グラウンドワーカー(スペック §BenchJob 不変条件 4)。30 秒ごとに
// sweepTimedOutJobs を実行する。catchAllCause を repeat の手前に置くことで
// sweepTimedOutJobs が失敗(RepoError 等)しても E チャネルは never になり、
// repeat がそのまま次の周期を続ける(1 回の失敗で fiber が死んで以後スイープ
// が止まる、という事態を避ける)。
export const TimeoutSweeperLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    yield* sweepTimedOutJobs.pipe(
      Effect.tap((n) => (n > 0 ? Effect.logWarning(`timed out ${n} bench job(s)`) : Effect.void)),
      Effect.catchAllCause(Effect.logError),
      Effect.repeat(Schedule.spaced("30 seconds")),
      Effect.forkScoped
    )
  })
)
