// loop.ts の結合テスト。ポータルは HTTP を経由しない Effect レベルのスタブ
// Layer(PortalClient)に差し替え、ベンチプロセスも `node -e` の 1 行スクリプト
// による偽ベンチ(adapter 差し替え)で置き換える。実プロセス起動・実タイマーを
// 使うため it.scopedLive(TestClock を使わない実時間のテスト)で書く
// (brief: 「テストでは TestClock…だが Command 実行と絡む部分は偽ベンチ…を
// 使った it.live でも良い」)。実行時間は 1〜2 秒に収めている。
import { NodeContext } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Duration, Effect, Either, Fiber, Layer, Option, Ref } from "effect"
import { mkdtempSync, readFileSync } from "node:fs"
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

const makeFakeAdapter = (problemKey: string): ProblemAdapter => ({
  problemKey,
  command: () => ({ cmd: process.execPath, args: ["-e", fakeBenchScript], cwd: process.cwd() }),
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

      // プロセスが起動して pid ファイルを書き出すのを待ってから interrupt する。
      yield* runLoopFor(400, testLayer)

      const pid = Number(readFileSync(pidFile, "utf8").trim())
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
