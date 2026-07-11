import { Effect, Layer, Option, Schedule } from "effect"
import { runNextOrchestrationStep } from "../../application/usecases/provisioning.js"

// 払い出し/撤収オーケストレーションの常駐ワーカー(スペック §アーキテクチャ、
// TimeoutSweeper と同型)。2 秒ごとに runNextOrchestrationStep を呼び、
// creating/deleting の instance を「1 度に 1 件だけ」拾って saga を進める。
//
// 全体で同時 1 インスタンスのみオーケストレーションする制約(clone/RAM の
// 競合回避、BenchJob の全体 1 本と同型)は、このワーカーが単一の非並行ループ
// (forkScoped した fiber 1 本の Effect.repeat)で runNextOrchestrationStep を
// 直列に呼ぶことで満たす。runNextOrchestrationStep は 1 件の saga を完了させて
// から返るため、次の tick まで別インスタンスの処理は始まらない。
//
// catchAllCause を repeat の手前に置く生存性優先思想も TimeoutSweeper と同じ:
// runNextOrchestrationStep 自体は saga の失敗をすべて markFailed に畳み込んで
// E=never を返す設計だが、万一の defect(die)でも fiber を殺さず次周期を
// 続けるため、ここで最終防衛として cause を握って logError する。
export const ProvisionerLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    yield* runNextOrchestrationStep.pipe(
      Effect.tap((result) =>
        Option.match(result, {
          onNone: () => Effect.void,
          onSome: (instance) =>
            Effect.logInfo(`orchestrated instance ${instance.id} → ${instance.status}`)
        })
      ),
      Effect.catchAllCause(Effect.logError),
      Effect.repeat(Schedule.spaced("2 seconds")),
      Effect.forkScoped
    )
  })
)
