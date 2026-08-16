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
import { existsSync, statSync } from "node:fs"
import type { BenchJobId, RunnerFinishRequest, RunnerJob, RunnerPollRequest, RunnerProgressRequest } from "shared/schemas"
import type { ProblemAdapter } from "./adapters/types.js"

// --- ポータル(shared/api の runner グループ)を薄く抜いたインタフェース。
// loop.ts はこの形にだけ依存し、実体(HttpApiClient 経由か、テストのスタブか)は
// Layer 側で差し替える。 ---
// PortalClientShape.poll は RunnerPollRequest (heartbeat + poll) を受ける形に
// 変わった。実装(HttpApiClient / テストスタブ)がヘルスデータを body に載せ、
// ポータルは runner_agents を touch した後で「benchReady=true なら」dequeue する。
export interface PortalClientShape {
  readonly poll: (request: RunnerPollRequest) => Effect.Effect<Option.Option<RunnerJob>, unknown>
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

// LoopConfig: pollIntervalMillis / progressIntervalMillis に加え、Task 10 で
// heartbeat 用の runnerId / revision / BENCH_DIR を追加した。main.ts が env 経由で
// 埋め、テストは Layer.succeed で fixed value を渡す。
export interface LoopConfigShape {
  readonly pollIntervalMillis: number
  readonly progressIntervalMillis: number
  readonly runnerId: string
  readonly runnerRevision: string
  readonly benchDir: string
}

export class LoopConfig extends Context.Tag("runner/LoopConfig")<LoopConfig, LoopConfigShape>() {}

// progress/finish の POST 失敗のリトライ方針(brief: 3 回リトライして駄目なら
// ログだけ残して次へ)。
const reportRetrySchedule = Schedule.exponential("1 second").pipe(Schedule.compose(Schedule.recurs(3)))

// リトライしても失敗した報告は、ジョブ全体を殺さずログに残すだけにする
// (このジョブの結果がポータルに伝わらない可能性は残るが、次のポーリング
// サイクルは継続させることを優先する)。戻り値は送信が最終的に成功したか
// どうか(true/false、失敗しない)。呼び出し側(sendProgress)はこれを見て
// sentRef を進めるかどうかを判断する(Minor 3: 送信成功時だけ進める)。
const reportOrLog = <A>(label: string, effect: Effect.Effect<A, unknown>): Effect.Effect<boolean> =>
  effect.pipe(
    Effect.retry(reportRetrySchedule),
    Effect.as(true),
    Effect.catchAllCause((cause) => Effect.logError(`${label} failed after retries`, cause).pipe(Effect.as(false)))
  )

// 実行中プロセスの stdout/stderr を蓄積しつつ、progressIntervalMillis ごとに
// 未送信分を progress として POST する。
// Command 実行 & ストリーム消費は呼び出し側(runJob)が Effect.scoped で包み、
// スコープが閉じる(=ジョブ完了 or シャットダウンでの interrupt)際に子プロセス
// が確実に kill される。
// combinedLogRef/sentRef は runJob 側で(プロセス起動前に)作って渡す。こうする
// ことで、Command.start 自体や途中のストリーム処理が失敗して runBenchProcess
// が例外的に終了しても、runJob の catchAllCause フォールバックがその時点までの
// 蓄積ログ(未送信分)を logTail に載せられる(Minor 4)。
const runBenchProcess = (
  portal: PortalClientShape,
  jobId: BenchJobId,
  adapter: ProblemAdapter,
  command: Command.Command,
  progressIntervalMillis: number,
  combinedLogRef: Ref.Ref<string>,
  sentRef: Ref.Ref<number>
) =>
  Effect.gen(function* () {
    const process = yield* Command.start(command)

    // stdout 単体(parseResult/parsePartialScore 用、契約は stdout のみ)と、
    // stdout+stderr の合流ログ(progress の logChunk / finish の logTail に
    // 載せる、参加者向けの診断ログ)を分けて蓄積する。
    const stdoutRef = yield* Ref.make("")

    const appendToStdout = (chunk: string) =>
      Effect.all([Ref.update(stdoutRef, (s) => s + chunk), Ref.update(combinedLogRef, (s) => s + chunk)], {
        discard: true
      })
    const appendToCombinedOnly = (chunk: string) => Ref.update(combinedLogRef, (s) => s + chunk)

    const stdoutFiber = yield* Stream.decodeText(process.stdout).pipe(
      Stream.runForEach(appendToStdout),
      Effect.fork
    )
    const stderrFiber = yield* Stream.decodeText(process.stderr).pipe(
      Stream.runForEach(appendToCombinedOnly),
      Effect.fork
    )

    // 合流ログのうち未送信分を切り出して返す。sentRef は「送信に成功した後」
    // にだけ進める(呼び出し側の責務。ここでは切り出すだけで sentRef は
    // 変更しない)。これにより、送信が失敗してリトライも尽きた場合に、その
    // 増分が恒久的に失われず次回の progress/finish で再送される
    // (多少の重複より欠落を避ける方針)。
    const peekUnsent = Effect.gen(function* () {
      const combined = yield* Ref.get(combinedLogRef)
      const sent = yield* Ref.get(sentRef)
      return { combined, chunk: combined.slice(sent) }
    })

    const sendProgress = Effect.gen(function* () {
      const { chunk, combined } = yield* peekUnsent
      const stdoutSoFar = yield* Ref.get(stdoutRef)
      const partialScore = Option.getOrNull(adapter.parsePartialScore(stdoutSoFar))
      // ポータル側は空 logChunk でも last_progress_at を更新する設計
      // (ハートビート)なので、chunk が空でも interval ごとに必ず POST する。
      // これにより、ベンチが stdout を出さない期間もタイムアウト回収
      // (10 分)に誤検知されない。
      const succeeded = yield* reportOrLog(
        "reportProgress",
        portal.reportProgress(jobId, { logChunk: chunk, partialScore })
      )
      // 送信(リトライ込み)が実際に成功した場合にだけ、送信済み位置を進める。
      // 失敗した場合は combinedLogRef 上の当該区間を未送信のままにし、次回の
      // progress(または finish の logTail)で再送されるようにする(Minor 3)。
      if (succeeded) {
        yield* Ref.set(sentRef, combined.length)
      }
    })

    const progressFiber = yield* sendProgress.pipe(
      Effect.repeat(Schedule.spaced(Duration.millis(progressIntervalMillis))),
      Effect.fork
    )

    const exitCode = yield* process.exitCode.pipe(Effect.ensuring(Fiber.interrupt(progressFiber)))

    // プロセス終了後、ストリームが EOF まで消費されるのを待ってから最終ログを読む。
    yield* Fiber.join(stdoutFiber)
    yield* Fiber.join(stderrFiber)

    const stdout = yield* Ref.get(stdoutRef)
    const { chunk: logTail } = yield* peekUnsent

    if (Number(exitCode) !== 0) {
      return {
        passed: false,
        score: 0,
        errorMessage: `benchmarker process exited with code ${Number(exitCode)}`,
        logTail
      } satisfies RunnerFinishRequest
    }

    return Either.match(adapter.parseResult(stdout), {
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

    // プロセス起動前に作っておくことで、Command.start 自体や途中のストリーム
    // 処理が失敗した場合でも、catchAllCause フォールバックがその時点までの
    // 蓄積ログ(未送信分)を logTail に載せられる(Minor 4)。
    const combinedLogRef = yield* Ref.make("")
    const sentRef = yield* Ref.make(0)

    const finishRequest = yield* Effect.scoped(
      runBenchProcess(portal, job.id, adapter, command, progressIntervalMillis, combinedLogRef, sentRef)
    ).pipe(
      Effect.catchAllCause((cause) =>
        Effect.gen(function* () {
          const combined = yield* Ref.get(combinedLogRef)
          const sent = yield* Ref.get(sentRef)
          return {
            passed: false,
            score: 0,
            errorMessage: `failed to run benchmarker process: ${cause}`,
            logTail: combined.slice(sent)
          } satisfies RunnerFinishRequest
        })
      )
    )

    yield* reportOrLog("reportFinish", portal.reportFinish(job.id, finishRequest))
  })

// ローカルヘルスチェック: BENCH_DIR が実在するディレクトリなら bench の起動が
// 見込める、そうでなければ benchReady=false + summary で portal に heartbeat する。
// 内容は非機密で 256 文字以内 (shared schema の CHECK と揃える)。adapter レジストリ
// が空なら「未知の problemKey しか処理できない」= benchReady=false 相当。
const evaluateBenchHealth = Effect.gen(function* () {
  const config = yield* LoopConfig
  const adapters = yield* AdapterRegistry
  const adapterKeys = Object.keys(adapters)
  if (adapterKeys.length === 0) {
    return { benchReady: false, healthSummary: "no adapters registered" } as const
  }
  const dirCheck = yield* Effect.sync(() => {
    try {
      if (!existsSync(config.benchDir)) return { ok: false as const, summary: "bench dir missing" }
      const stat = statSync(config.benchDir)
      if (!stat.isDirectory()) return { ok: false as const, summary: "bench dir not directory" }
      return { ok: true as const, summary: `bench dir ok (adapters=${adapterKeys.length})` }
    } catch {
      return { ok: false as const, summary: "bench dir stat failed" }
    }
  })
  return { benchReady: dirCheck.ok, healthSummary: dirCheck.summary } as const
})

// poll 1 回分(ジョブが無ければ pollIntervalMillis だけ待つ)。
const iteration = Effect.gen(function* () {
  const portal = yield* PortalClient
  const config = yield* LoopConfig

  const { benchReady, healthSummary } = yield* evaluateBenchHealth
  // healthSummary は 256 文字以内に丸める (shared schema の CHECK と揃える)。
  const bounded = healthSummary.length > 256 ? healthSummary.slice(0, 256) : healthSummary
  const jobOption = yield* portal.poll({
    runnerId: config.runnerId,
    revision: config.runnerRevision,
    benchReady,
    healthSummary: bounded
  })

  yield* Option.match(jobOption, {
    onNone: () => Effect.sleep(Duration.millis(config.pollIntervalMillis)),
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
