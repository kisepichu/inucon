import { it } from "@effect/vitest"
import { Context, Effect, Either, Layer, Option, Ref, TestClock } from "effect"
import { describe, expect } from "vitest"
import { BenchJob, newJob, startJob } from "../../src/domain/benchJob.js"
import { BenchJobId, TeamId } from "../../src/domain/ids.js"
import { DEFAULT_TEST_CONTEST_ID } from "../support/factories.js"
import { BenchJobRepo, RepoError } from "../../src/application/ports.js"
import { TimeoutSweeperLive } from "../../src/infrastructure/worker/timeoutSweeper.js"
import { makeBenchJobRepoTest, RunnerConfigTest } from "../support/inMemory.js"

// TimeoutSweeperLive は「Layer として動く」ことが要点(Task 8 ブリーフ):
// 30 秒ごとに sweepTimedOutJobs を実行し続けるバックグラウンドワーカーとして
// 正しくスケジューリングされること、そして 1 回の失敗(RepoError)で fiber が
// 死なず次周期も走り続けることを確認する。sweepTimedOutJobs 自体の判定ロジック
// (best/latest 等)は test/application/bench.test.ts で既にカバーされているため
// ここでは重複させない。

const team1Id = TeamId.make("11111111-1111-1111-1111-111111111111")
const team2Id = TeamId.make("22222222-2222-2222-2222-222222222222")

const runningJobWithProgress = (args: { id: BenchJobId; teamId: TeamId; lastProgressAt: number }) => {
  const started = Either.getOrThrow(
    startJob(
      newJob({
        id: args.id,
        contestId: DEFAULT_TEST_CONTEST_ID,
        teamId: args.teamId,
        targetIp: "10.100.1.9",
        targetPort: 8080,
        purpose: "competition",
        now: 0
      }),
      0
    )
  )
  return new BenchJob({ ...started, lastProgressAt: Option.some(args.lastProgressAt) })
}

// 30 秒(Schedule.spaced("30 seconds"))を N 回進める。TestClock.adjust は
// その 1 回の呼び出しで、締切がその区間内に来るすべての sleep をアトミックに
// 起こす(cascade する再スケジューリングも同一呼び出し内で処理される)ため、
// 1 tick = 1 サイクルとして安全に扱える。
const advanceTicks = (n: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < n; i++) {
      yield* TestClock.adjust("30 seconds")
    }
  })

describe("TimeoutSweeperLive", () => {
  it.effect("30 秒 x N 周期後、10 分無進捗の running が failed になり、直近進捗ありは無傷", () =>
    Effect.gen(function* () {
      const staleId = BenchJobId.make("33333333-3333-3333-3333-333333333333")
      const freshId = BenchJobId.make("44444444-4444-4444-4444-444444444444")

      // 21 tick = 630_000ms。jobTimeoutMillis=600_000 なので cutoff=30_000。
      // stale(lastProgressAt=0)は 0 < 30_000 で対象、fresh(600_000)は
      // 600_000 < 30_000 ではないので無傷。
      const reposLayer = makeBenchJobRepoTest([
        runningJobWithProgress({ id: staleId, teamId: team1Id, lastProgressAt: 0 }),
        runningJobWithProgress({ id: freshId, teamId: team2Id, lastProgressAt: 600_000 })
      ])
      const configLayer = RunnerConfigTest(600_000)
      const workerLayer = TimeoutSweeperLive.pipe(Layer.provide(reposLayer), Layer.provide(configLayer))
      // reposLayer/configLayer は workerLayer にも直接にも同一参照で渡す。
      // Layer 構築は 1 回の Effect.provide 呼び出しにつき 1 つの MemoMap を
      // 共有するため、同一参照の Layer は 1 度しか構築されず状態が共有される
      // (main.ts の ReposLive/RunnerConfigLive の再利用と同じ理屈)。
      const testLayer = Layer.mergeAll(workerLayer, reposLayer, configLayer)

      yield* Effect.gen(function* () {
        yield* advanceTicks(21)

        const jobs = yield* BenchJobRepo
        const stale = yield* jobs.findById(staleId)
        const fresh = yield* jobs.findById(freshId)
        expect(Option.isSome(stale)).toBe(true)
        expect(Option.isSome(fresh)).toBe(true)
        if (Option.isSome(stale)) {
          expect(stale.value.status).toBe("failed")
          expect(stale.value.errorMessage).toStrictEqual(Option.some("timeout"))
        }
        if (Option.isSome(fresh)) {
          expect(fresh.value.status).toBe("running")
        }
      }).pipe(Effect.provide(testLayer))
    })
  )

  it.effect("sweepTimedOutJobs が RepoError で失敗し続けても fiber は死なず次周期も呼び続ける", () =>
    Effect.gen(function* () {
      const callsRef = yield* Ref.make(0)
      const notUsed = () => Effect.dieMessage("not used in this test")
      const flakyRepo: Context.Tag.Service<BenchJobRepo> = {
        insertIfAllowed: notUsed,
        findById: notUsed,
        listByTeam: notUsed,
        dequeueNextQueued: notUsed,
        appendLog: notUsed,
        getLog: notUsed,
        recordProgressIfRunning: notUsed,
        finishIfRunning: notUsed,
        failIfRunning: notUsed,
        cancelIfQueued: notUsed,
        cancelQueuedRehearsalsForContest: notUsed,
        scoreboard: () => Effect.succeed([]),
        countSuccessfulRehearsals: () => Effect.succeed(0),
        // 常に RepoError を返す(sweep が失敗し続けるケースを再現する)。
        failTimedOutJobs: () =>
          Ref.updateAndGet(callsRef, (n) => n + 1).pipe(
            Effect.flatMap(() => Effect.fail(new RepoError({ cause: "boom" })))
          )
      }

      const workerLayer = TimeoutSweeperLive.pipe(
        Layer.provide(Layer.succeed(BenchJobRepo, flakyRepo)),
        Layer.provide(RunnerConfigTest(600_000))
      )

      yield* advanceTicks(3).pipe(Effect.provide(workerLayer))

      // t=0(fork 時の即時実行)+ 3 tick = 4 回。すべて RepoError で失敗するが
      // catchAllCause(Effect.logError)が repeat の手前にあるため、E チャネルは
      // never になり fiber は止まらず次周期を呼び続ける。
      const calls = yield* Ref.get(callsRef)
      expect(calls).toBe(4)
    })
  )
})
