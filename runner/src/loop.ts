// ベンチランナーのメインループ(brief §loop.ts、スペック §4「ベンチランナー」)。
//
// poll → (ジョブなし: pollIntervalMillis 待って再 poll) →
//        (ジョブあり: アダプタで実行、5 秒ごとに progress、終了で finish)
// を繰り返す。ループ全体は Effect.catchAllCause(logError) で不死身にし、1 件の
// ジョブの異常(アダプタが無い/プロセス起動失敗/ポータルへの報告失敗)が
// ランナープロセス自体を落とさないようにする(portal の TimeoutSweeperLive と
// 同じ生存性優先の思想)。
import { Command, CommandExecutor } from "@effect/platform"
import { Context, Duration, Effect, Either, Fiber, Option, Ref, Schedule, Stream } from "effect"
import type { BenchJobId, RunnerFinishRequest, RunnerJob, RunnerProgressRequest } from "shared/schemas"
import type { ProblemAdapter } from "./adapters/types.js"

// --- ポータル(shared/api の runner グループ)を薄く抜いたインタフェース。
// loop.ts はこの形にだけ依存し、実体(HttpApiClient 経由か、テストのスタブか)は
// Layer 側で差し替える。 ---
export interface PortalClientShape {
  readonly poll: Effect.Effect<Option.Option<RunnerJob>, unknown>
  readonly reportProgress: (jobId: BenchJobId, request: RunnerProgressRequest) => Effect.Effect<void, unknown>
  readonly reportFinish: (jobId: BenchJobId, request: RunnerFinishRequest) => Effect.Effect<void, unknown>
}

export class PortalClient extends Context.Tag("runner/PortalClient")<PortalClient, PortalClientShape>() {}

// problemKey → ProblemAdapter のレジストリ。未知の problemKey は runJob が
// errorMessage 付き finish で failed 報告する(brief: 「未知の problemKey は
// ジョブを errorMessage 付き finish で failed 報告」)。
export type AdapterRegistryShape = Readonly<Record<string, ProblemAdapter>>

export class AdapterRegistry extends Context.Tag("runner/AdapterRegistry")<
  AdapterRegistry,
  AdapterRegistryShape
>() {}

export interface LoopConfigShape {
  readonly pollIntervalMillis: number
  readonly progressIntervalMillis: number
}

export class LoopConfig extends Context.Tag("runner/LoopConfig")<LoopConfig, LoopConfigShape>() {}

// progress/finish の POST 失敗のリトライ方針(brief: 3 回リトライして駄目なら
// ログだけ残して次へ)。
const reportRetrySchedule = Schedule.exponential("1 second").pipe(Schedule.compose(Schedule.recurs(3)))

// リトライしても失敗した報告は、ジョブ全体を殺さずログに残すだけにする
// (このジョブの結果がポータルに伝わらない可能性は残るが、次のポーリング
// サイクルは継続させることを優先する)。
const reportOrLog = <A>(label: string, effect: Effect.Effect<A, unknown>) =>
  effect.pipe(
    Effect.retry(reportRetrySchedule),
    Effect.catchAllCause((cause) => Effect.logError(`${label} failed after retries`, cause)),
    Effect.asVoid
  )

// 実行中プロセスの stdout/stderr を 1 本のログ文字列に蓄積しつつ、
// progressIntervalMillis ごとに未送信分を progress として POST する。
// Command 実行 & ストリーム消費は呼び出し側(runJob)が Effect.scoped で包み、
// スコープが閉じる(=ジョブ完了 or シャットダウンでの interrupt)際に子プロセス
// が確実に kill される。
const runBenchProcess = (
  portal: PortalClientShape,
  jobId: BenchJobId,
  adapter: ProblemAdapter,
  command: Command.Command,
  progressIntervalMillis: number
) =>
  Effect.gen(function* () {
    const process = yield* Command.start(command)

    const logRef = yield* Ref.make("")
    const sentRef = yield* Ref.make(0)

    const appendToLog = (chunk: string) => Ref.update(logRef, (s) => s + chunk)

    const stdoutFiber = yield* Stream.decodeText(process.stdout).pipe(
      Stream.runForEach(appendToLog),
      Effect.fork
    )
    const stderrFiber = yield* Stream.decodeText(process.stderr).pipe(
      Stream.runForEach(appendToLog),
      Effect.fork
    )

    // 蓄積済みログのうち未送信分を切り出して返す(送信済み位置を進める副作用込み)。
    const takeUnsent = Effect.gen(function* () {
      const full = yield* Ref.get(logRef)
      const sent = yield* Ref.get(sentRef)
      const chunk = full.slice(sent)
      yield* Ref.set(sentRef, full.length)
      return { full, chunk }
    })

    const sendProgress = Effect.gen(function* () {
      const { chunk, full } = yield* takeUnsent
      if (chunk === "") return
      const partialScore = Option.getOrNull(adapter.parsePartialScore(full))
      yield* reportOrLog("reportProgress", portal.reportProgress(jobId, { logChunk: chunk, partialScore }))
    })

    const progressFiber = yield* sendProgress.pipe(
      Effect.repeat(Schedule.spaced(Duration.millis(progressIntervalMillis))),
      Effect.fork
    )

    const exitCode = yield* process.exitCode.pipe(Effect.ensuring(Fiber.interrupt(progressFiber)))

    // プロセス終了後、ストリームが EOF まで消費されるのを待ってから最終ログを読む。
    yield* Fiber.join(stdoutFiber)
    yield* Fiber.join(stderrFiber)

    const full = yield* Ref.get(logRef)
    const { chunk: logTail } = yield* takeUnsent

    if (Number(exitCode) !== 0) {
      return {
        passed: false,
        score: 0,
        errorMessage: `benchmarker process exited with code ${Number(exitCode)}`,
        logTail
      } satisfies RunnerFinishRequest
    }

    return Either.match(adapter.parseResult(full), {
      onLeft: (error) =>
        ({ passed: false, score: 0, errorMessage: error.message, logTail } satisfies RunnerFinishRequest),
      onRight: (result) =>
        ({ passed: result.passed, score: result.score, errorMessage: null, logTail } satisfies RunnerFinishRequest)
    })
  })

// 1 ジョブ分の実行(アダプタ解決 → プロセス起動 → 完了報告)。
const runJob = (job: RunnerJob) =>
  Effect.gen(function* () {
    const portal = yield* PortalClient
    const registry = yield* AdapterRegistry
    const { progressIntervalMillis } = yield* LoopConfig

    const adapter = registry[job.problemKey]
    if (adapter === undefined) {
      yield* reportOrLog(
        "reportFinish",
        portal.reportFinish(job.id, {
          passed: false,
          score: 0,
          errorMessage: `unknown problemKey: ${job.problemKey}`,
          logTail: ""
        })
      )
      return
    }

    const spec = adapter.command({ ip: job.targetIp, port: job.targetPort })
    const command = Command.make(spec.cmd, ...spec.args).pipe(Command.workingDirectory(spec.cwd))

    const finishRequest = yield* Effect.scoped(
      runBenchProcess(portal, job.id, adapter, command, progressIntervalMillis)
    ).pipe(
      Effect.catchAllCause((cause) =>
        Effect.succeed({
          passed: false,
          score: 0,
          errorMessage: `failed to run benchmarker process: ${cause}`,
          logTail: ""
        } satisfies RunnerFinishRequest)
      )
    )

    yield* reportOrLog("reportFinish", portal.reportFinish(job.id, finishRequest))
  })

// poll 1 回分(ジョブが無ければ pollIntervalMillis だけ待つ)。
const iteration = Effect.gen(function* () {
  const portal = yield* PortalClient
  const { pollIntervalMillis } = yield* LoopConfig

  const jobOption = yield* portal.poll

  yield* Option.match(jobOption, {
    onNone: () => Effect.sleep(Duration.millis(pollIntervalMillis)),
    onSome: runJob
  })
})

// エクスポートするメインループ。main.ts から
// `runLoop.pipe(Effect.provide(liveLayer), NodeRuntime.runMain)` の形で使う。
export const runLoop: Effect.Effect<
  never,
  never,
  PortalClient | AdapterRegistry | LoopConfig | CommandExecutor.CommandExecutor
> = iteration.pipe(Effect.catchAllCause(Effect.logError), Effect.forever)
