// loop.ts の結合テスト。ポータルは HTTP を経由しない Effect レベルのスタブ
// Layer(PortalClient)に差し替え、ベンチプロセスも `node -e` の 1 行スクリプト
// による偽ベンチ(adapter 差し替え)で置き換える。実プロセス起動・実タイマーを
// 使うため it.scopedLive(TestClock を使わない実時間のテスト)で書く
// (brief: 「テストでは TestClock…だが Command 実行と絡む部分は偽ベンチ…を
// 使った it.live でも良い」)。実行時間は 1〜2 秒に収めている。
import { NodeContext } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Duration, Effect, Either, Fiber, Layer, Option, Ref } from "effect"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BenchJobId, RunnerFinishRequest, RunnerJob, RunnerProgressRequest } from "shared/schemas"
import { BenchJobId as BenchJobIdSchema, TeamId as TeamIdSchema } from "shared/schemas"
import { describe, expect } from "vitest"
import { AdapterParseError, type ProblemAdapter } from "../src/adapters/types.js"
import { AdapterRegistry, LoopConfig, PortalClient, type PortalClientShape, runLoop } from "../src/loop.js"

// 偽ベンチ: 50ms 後に進捗っぽい 1 行を stdout に出し、400ms 後に最終 JSON を
// 出して正常終了する(node -e のワンライナー、実時間はテスト全体で 1.2 秒程度)。
const fakeBenchScript =
  "setTimeout(() => { process.stdout.write('warming up\\n') }, 50);" +
  "setTimeout(() => { console.log(JSON.stringify({ pass: true, score: 777, messages: [] })) }, 400)"

const makeFakeAdapter = (problemKey: string, script: string = fakeBenchScript): ProblemAdapter => ({
  problemKey,
  command: () => ({ cmd: process.execPath, args: ["-e", script], cwd: process.cwd() }),
  parseResult: (stdout) => {
    const line = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("{"))
      .at(-1)
    if (line === undefined) {
      return Either.left(new AdapterParseError({ message: "no JSON line" }))
    }
    const parsed = JSON.parse(line) as { pass: boolean; score: number; messages?: ReadonlyArray<string> }
    return Either.right({ passed: parsed.pass, score: parsed.score, messages: parsed.messages ?? [] })
  },
  parsePartialScore: () => Option.none()
})

// 偽ベンチ(ハートビート検証用): 500ms の間 stdout に何も出さず、その後に最終
// JSON を出して正常終了する。stdout が沈黙している区間でも progress の
// ハートビート(空 logChunk の POST)が interval ごとに飛ぶことを確認するため
// に使う。
const silentThenResultScript =
  "setTimeout(() => { console.log(JSON.stringify({ pass: true, score: 42, messages: [] })) }, 500)"

// 偽ベンチ(stderr 分離検証用): 起動直後に stderr へ `{...}` 形式の行(本物の
// 結果 JSON と紛らわしい)を書き出し、その後 stdout に正しい結果 JSON を出す。
// parseResult には stdout のみが渡ることを確認するのに使う。
const stderrNoiseScript =
  "process.stderr.write('{\"pass\":false,\"score\":999,\"messages\":[]}\\n');" +
  "setTimeout(() => { console.log(JSON.stringify({ pass: true, score: 777, messages: [] })) }, 100)"

// PortalClient のスタブ: ジョブキュー(Ref)と、progress/finish の呼び出しを
// 記録する Ref を持つ。HTTP は一切経由しない。
const makeStubPortal = (initialJobs: ReadonlyArray<RunnerJob>) =>
  Effect.gen(function* () {
    const jobsRef = yield* Ref.make(initialJobs)
    const progressCallsRef = yield* Ref.make<ReadonlyArray<RunnerProgressRequest>>([])
    const finishCallsRef = yield* Ref.make<ReadonlyArray<readonly [BenchJobId, RunnerFinishRequest]>>([])

    const portal: PortalClientShape = {
      poll: Ref.modify(jobsRef, (jobs): [Option.Option<RunnerJob>, ReadonlyArray<RunnerJob>] =>
        jobs.length === 0 ? [Option.none(), jobs] : [Option.some(jobs[0]), jobs.slice(1)]
      ),
      reportProgress: (_jobId, request) => Ref.update(progressCallsRef, (a) => [...a, request]),
      reportFinish: (jobId, request) => Ref.update(finishCallsRef, (a) => [...a, [jobId, request] as const])
    }

    return { portal, progressCallsRef, finishCallsRef }
  })

// runLoop を testLayer 付きで fork し、durationMillis 待ってから interrupt する。
const runLoopFor = (durationMillis: number, testLayer: Layer.Layer<PortalClient | AdapterRegistry | LoopConfig>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.fork(runLoop.pipe(Effect.provide(testLayer), Effect.provide(NodeContext.layer)))
    yield* Effect.sleep(Duration.millis(durationMillis))
    yield* Fiber.interrupt(fiber)
  })

describe("runLoop", () => {
  it.scopedLive("poll → 実行(偽ベンチ)→ progress ≥1 回 → finish が報告される", () =>
    Effect.gen(function* () {
      const job: RunnerJob = {
        id: BenchJobIdSchema.make("job-1"),
        teamId: TeamIdSchema.make("team-1"),
        targetIp: "127.0.0.1",
        targetPort: 12345,
        problemKey: "fake"
      }

      const { finishCallsRef, portal, progressCallsRef } = yield* makeStubPortal([job])

      const testLayer = Layer.mergeAll(
        Layer.succeed(PortalClient, portal),
        Layer.succeed(AdapterRegistry, { fake: makeFakeAdapter("fake") }),
        Layer.succeed(LoopConfig, { pollIntervalMillis: 50, progressIntervalMillis: 150 })
      )

      yield* runLoopFor(1200, testLayer)

      const finishes = yield* Ref.get(finishCallsRef)
      const progresses = yield* Ref.get(progressCallsRef)

      expect(finishes).toHaveLength(1)
      const [finishedJobId, finishRequest] = finishes[0]
      expect(finishedJobId).toBe(job.id)
      expect(finishRequest.passed).toBe(true)
      expect(finishRequest.score).toBe(777)
      expect(finishRequest.errorMessage).toBeNull()

      expect(progresses.length).toBeGreaterThanOrEqual(1)
      expect(progresses.some((p) => p.logChunk.includes("warming up"))).toBe(true)
    })
  )

  it.scopedLive("stdout が出ない区間でも progress(ハートビート)が interval ごとに飛ぶ", () =>
    Effect.gen(function* () {
      const job: RunnerJob = {
        id: BenchJobIdSchema.make("job-heartbeat"),
        teamId: TeamIdSchema.make("team-1"),
        targetIp: "127.0.0.1",
        targetPort: 12345,
        problemKey: "silent"
      }

      const { progressCallsRef, portal } = yield* makeStubPortal([job])

      const testLayer = Layer.mergeAll(
        Layer.succeed(PortalClient, portal),
        Layer.succeed(AdapterRegistry, { silent: makeFakeAdapter("silent", silentThenResultScript) }),
        // progress 100ms ごと、ベンチは 500ms 沈黙してから結果を出す。
        // 700ms 走らせれば、沈黙区間だけで複数回のハートビートが飛ぶはず。
        Layer.succeed(LoopConfig, { pollIntervalMillis: 50, progressIntervalMillis: 100 })
      )

      yield* runLoopFor(700, testLayer)

      const progresses = yield* Ref.get(progressCallsRef)

      // 沈黙区間(結果が出る 500ms より前)の progress は logChunk が空でも
      // 必ず POST されているはず(ハートビート)。
      const heartbeats = progresses.filter((p) => p.logChunk === "")
      expect(heartbeats.length).toBeGreaterThanOrEqual(2)
    })
  )

  it.scopedLive("stderr に `{...}` 行が混ざっても parseResult は stdout の JSON を使う", () =>
    Effect.gen(function* () {
      const job: RunnerJob = {
        id: BenchJobIdSchema.make("job-stderr"),
        teamId: TeamIdSchema.make("team-1"),
        targetIp: "127.0.0.1",
        targetPort: 12345,
        problemKey: "stderr-noise"
      }

      const { finishCallsRef, portal } = yield* makeStubPortal([job])

      const testLayer = Layer.mergeAll(
        Layer.succeed(PortalClient, portal),
        Layer.succeed(AdapterRegistry, { "stderr-noise": makeFakeAdapter("stderr-noise", stderrNoiseScript) }),
        Layer.succeed(LoopConfig, { pollIntervalMillis: 50, progressIntervalMillis: 150 })
      )

      yield* runLoopFor(500, testLayer)

      const finishes = yield* Ref.get(finishCallsRef)
      expect(finishes).toHaveLength(1)
      const [, finishRequest] = finishes[0]
      // stderr の紛らわしい行(pass:false, score:999)ではなく、stdout の
      // 本物の結果(pass:true, score:777)が採用されていること。
      expect(finishRequest.passed).toBe(true)
      expect(finishRequest.score).toBe(777)
    })
  )

  it.scopedLive("未知の problemKey はプロセスを起動せず errorMessage 付きで failed 報告される", () =>
    Effect.gen(function* () {
      const job: RunnerJob = {
        id: BenchJobIdSchema.make("job-2"),
        teamId: TeamIdSchema.make("team-1"),
        targetIp: "127.0.0.1",
        targetPort: 12345,
        problemKey: "unknown-problem"
      }

      const { finishCallsRef, portal } = yield* makeStubPortal([job])

      const testLayer = Layer.mergeAll(
        Layer.succeed(PortalClient, portal),
        Layer.succeed(AdapterRegistry, { fake: makeFakeAdapter("fake") }),
        Layer.succeed(LoopConfig, { pollIntervalMillis: 50, progressIntervalMillis: 150 })
      )

      yield* runLoopFor(300, testLayer)

      const finishes = yield* Ref.get(finishCallsRef)
      expect(finishes).toHaveLength(1)
      const [finishedJobId, finishRequest] = finishes[0]
      expect(finishedJobId).toBe(job.id)
      expect(finishRequest.passed).toBe(false)
      expect(finishRequest.score).toBe(0)
      expect(finishRequest.errorMessage).toContain("unknown-problem")
    })
  )

  // グレースフルシャットダウン(brief §main.ts): 実行中のベンチプロセスは
  // Effect の Scope(runJob の Effect.scoped)で管理されるため、ジョブ実行中に
  // ループの fiber が interrupt されたら子プロセスも kill されることを確認する。
  it.scopedLive("ジョブ実行中にループを interrupt すると子プロセスも kill される", () =>
    Effect.gen(function* () {
      const pidFile = join(mkdtempSync(join(tmpdir(), "runner-test-")), "pid.txt")
      // 自身の pid をファイルに書き出し、30 秒 sleep する(interrupt されなければ
      // テストの実行時間内に完了しないくらい長い)長寿命の偽ベンチ。
      const longRunningScript =
        `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
        "setTimeout(() => {}, 30000)"

      const longRunningAdapter: ProblemAdapter = {
        problemKey: "long-running",
        command: () => ({ cmd: process.execPath, args: ["-e", longRunningScript], cwd: process.cwd() }),
        parseResult: () => Either.left(new AdapterParseError({ message: "unused" })),
        parsePartialScore: () => Option.none()
      }

      const job: RunnerJob = {
        id: BenchJobIdSchema.make("job-3"),
        teamId: TeamIdSchema.make("team-1"),
        targetIp: "127.0.0.1",
        targetPort: 12345,
        problemKey: "long-running"
      }

      const { portal } = yield* makeStubPortal([job])

      const testLayer = Layer.mergeAll(
        Layer.succeed(PortalClient, portal),
        Layer.succeed(AdapterRegistry, { "long-running": longRunningAdapter }),
        Layer.succeed(LoopConfig, { pollIntervalMillis: 50, progressIntervalMillis: 150 })
      )

      const fiber = yield* Effect.fork(runLoop.pipe(Effect.provide(testLayer), Effect.provide(NodeContext.layer)))

      // プロセスが起動して pid ファイルを書き出すのを待ってから interrupt する。
      // 固定時間の sleep(旧: 400ms)だと CI 等の遅いマシンでフレークしうるため、
      // ファイル出現を 50ms 間隔・最大 3 秒でポーリングする。
      const pid = yield* Effect.gen(function* () {
        const deadlineMillis = Date.now() + 3000
        while (!existsSync(pidFile)) {
          if (Date.now() >= deadlineMillis) {
            return yield* Effect.dieMessage(`pid file did not appear within 3s: ${pidFile}`)
          }
          yield* Effect.sleep(Duration.millis(50))
        }
        return Number(readFileSync(pidFile, "utf8").trim())
      })

      yield* Fiber.interrupt(fiber)

      expect(Number.isInteger(pid)).toBe(true)

      // interrupt 後、子プロセスに signal 0 を送って生死を確認する(ESRCH なら
      // 既に死んでいる = kill されている)。
      yield* Effect.sleep(Duration.millis(200))
      let stillAlive = true
      try {
        process.kill(pid, 0)
      } catch {
        stillAlive = false
      }
      expect(stillAlive).toBe(false)
    })
  )
})
