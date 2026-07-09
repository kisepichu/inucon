import { Effect, Layer, Schedule } from "effect"
import { sweepTimedOutJobs } from "../../application/usecases/bench.js"

// 10 分(JOB_TIMEOUT_MILLIS)無進捗の running ジョブを failed 化するバック
// グラウンドワーカー(スペック §BenchJob 不変条件 4)。30 秒ごとに
// sweepTimedOutJobs を実行する。catchAllCause を repeat の手前に置くことで、
// typed error(RepoError)だけでなく defect でも E チャネルは never になり、
// repeat がそのまま次の周期を続ける。defect まで握って続行するのは意図的な
// 生存性優先の選択: 全体 running 1 本の制約下でスイーパーが止まると、stuck
// ジョブがキュー全体を恒久的に塞ぐ。defect は毎周期 logError で記録される
// ので、隠れるのではなく「うるさく生き続ける」側に倒している。
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
