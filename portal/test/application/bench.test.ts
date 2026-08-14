import { it } from "@effect/vitest"
import { Effect, Exit, Layer, Option, TestClock } from "effect"
import { describe, expect } from "vitest"
import { BenchJob, newJob, startJob } from "../../src/domain/benchJob.js"
import type { Contest } from "../../src/domain/contest.js"
import {
  CannotCancelRunning,
  ContestNotRunning,
  InvalidJobTransition,
  TargetIpOutOfSubnet,
  TeamJobAlreadyQueued
} from "../../src/domain/errors.js"
import { BenchJobId, TeamId, UserId } from "../../src/domain/ids.js"
import { User } from "../../src/domain/user.js"
import { Forbidden, NotInTeam } from "../../src/application/errors.js"
import { BenchJobRepo } from "../../src/application/ports.js"
import {
  cancelBench,
  enqueueBench,
  pollNextJob,
  reportFinish,
  reportProgress,
  sweepTimedOutJobs
} from "../../src/application/usecases/bench.js"
import { startContestUsecase } from "../../src/application/usecases/contest.js"
import { DEFAULT_TEST_CONTEST_ID, makeContest, makeTeam } from "../support/factories.js"
import {
  makeBenchJobRepoTest,
  makeContestRepoTest,
  makeTeamRepoTest,
  RunnerConfigTest,
  UuidGenTest
} from "../support/inMemory.js"
import { Either } from "effect"

const team1Id = TeamId.make("22222222-2222-2222-2222-222222222222")
const team2Id = TeamId.make("33333333-3333-3333-3333-333333333333")
const user1Id = UserId.make("44444444-4444-4444-4444-444444444444")
const user2Id = UserId.make("55555555-5555-5555-5555-555555555555")
const noTeamUserId = UserId.make("66666666-6666-6666-6666-666666666666")

const team1 = makeTeam({ id: team1Id, name: "team1", teamNumber: 1 })
const team2 = makeTeam({ id: team2Id, name: "team2", teamNumber: 2 })
const user1 = new User({
  id: user1Id,
  githubId: 1,
  githubLogin: "u1",
  displayName: "User 1",
  isAdmin: false,
  email: Option.none()
})
const noTeamUser = new User({
  id: noTeamUserId,
  githubId: 3,
  githubLogin: "u3",
  displayName: "User 3",
  isAdmin: false,
  email: Option.none()
})

// startJob は queued な BenchJob からのみ成功するので、テストデータ作りは
// 常に newJob() から作った queued ジョブを起点にする。
const runningJobAt = (args: { id: BenchJobId; teamId: TeamId; targetIp: string; enqueuedAt: number; now: number }) =>
  Either.getOrThrow(
    startJob(
      newJob({
        id: args.id,
        contestId: DEFAULT_TEST_CONTEST_ID,
        teamId: args.teamId,
        targetIp: args.targetIp,
        targetPort: 8080,
        purpose: "competition",
        now: args.enqueuedAt
      }),
      args.now
    )
  )

const queuedJob = (args: { id: BenchJobId; teamId: TeamId; targetIp: string; now: number }) =>
  newJob({
    id: args.id,
    contestId: DEFAULT_TEST_CONTEST_ID,
    teamId: args.teamId,
    targetIp: args.targetIp,
    targetPort: 8080,
    purpose: "competition",
    now: args.now
  })

const teamRepoLayer = makeTeamRepoTest({
  teams: [team1, team2],
  memberships: [
    { contestId: DEFAULT_TEST_CONTEST_ID, userId: user1Id, teamId: team1Id },
    { contestId: DEFAULT_TEST_CONTEST_ID, userId: user2Id, teamId: team2Id }
  ]
})
const testLayer = (
  contestStatus: Contest["status"],
  jobs: ReadonlyArray<BenchJob> = [],
  jobTimeoutMillis = 600_000
) =>
  Layer.mergeAll(
    UuidGenTest,
    makeContestRepoTest([makeContest({ id: DEFAULT_TEST_CONTEST_ID, status: contestStatus })]),
    teamRepoLayer,
    makeBenchJobRepoTest(jobs),
    RunnerConfigTest(jobTimeoutMillis)
  )

describe("enqueueBench", () => {
  it.effect("正常系: queued ジョブが返る", () =>
    Effect.gen(function* () {
      const job = yield* enqueueBench({ user: user1, targetIp: "10.100.1.5", targetPort: 8080 })
      expect(job.status).toBe("queued")
      expect(job.teamId).toBe(team1Id)
      expect(job.targetIp).toBe("10.100.1.5")
      expect(job.purpose).toBe("competition")
    }).pipe(Effect.provide(testLayer("running")))
  )

  it.effect("contest が preparing で 非 admin なら ContestNotRunning", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(enqueueBench({ user: user1, targetIp: "10.100.1.5", targetPort: 8080 }))
      expect(exit).toStrictEqual(Exit.fail(new ContestNotRunning({ status: "preparing" })))
    }).pipe(Effect.provide(testLayer("preparing")))
  )

  it.effect("既に自チームに queued があれば TeamJobAlreadyQueued", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(enqueueBench({ user: user1, targetIp: "10.100.1.5", targetPort: 8080 }))
      expect(exit).toStrictEqual(Exit.fail(new TeamJobAlreadyQueued({ teamId: team1Id })))
    }).pipe(
      Effect.provide(
        testLayer("running", [
          queuedJob({
            id: BenchJobId.make("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
            teamId: team1Id,
            targetIp: "10.100.1.9",
            now: 1000
          })
        ])
      )
    )
  )

  it.effect("他チームサブネットの IP なら TargetIpOutOfSubnet", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(enqueueBench({ user: user1, targetIp: "10.100.2.5", targetPort: 8080 }))
      expect(exit).toStrictEqual(Exit.fail(new TargetIpOutOfSubnet({ ip: "10.100.2.5", teamNumber: 1 })))
    }).pipe(Effect.provide(testLayer("running")))
  )

  it.effect("チームに所属しないユーザーは NotInTeam", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(enqueueBench({ user: noTeamUser, targetIp: "10.100.1.5", targetPort: 8080 }))
      expect(exit).toStrictEqual(Exit.fail(new NotInTeam()))
    }).pipe(Effect.provide(testLayer("running")))
  )
})

// preparing→running 遷移で queued rehearsal を残してはならない (残すと
// insertIfAllowed の NOT EXISTS が同一チームの competition enqueue を
// 永久ブロックする)。startContestUsecase 内で
// cancelQueuedRehearsalsForContest を呼ぶことで防いでいる。
describe("startContestUsecase: preparing 中の queued rehearsal を running 遷移でキャンセルする", () => {
  const admin1 = new User({ ...user1, isAdmin: true })

  it.effect("admin の rehearsal が queued のまま start しても、member の competition enqueue が阻害されない", () =>
    Effect.gen(function* () {
      // 1. preparing: admin が rehearsal を enqueue → queued のまま runner が拾わない状態を模す。
      const rehearsal = yield* enqueueBench({ user: admin1, targetIp: "10.100.1.5", targetPort: 8080 })
      expect(rehearsal.status).toBe("queued")
      expect(rehearsal.purpose).toBe("rehearsal")

      // 2. startContestUsecase: preparing → running 遷移 + queued rehearsal を一括キャンセル。
      yield* startContestUsecase

      // 3. 同一チームの一般ユーザが competition を enqueue できる。
      //    (rehearsal がキャンセルされていないと TeamJobAlreadyQueued で失敗する)。
      const competition = yield* enqueueBench({ user: user1, targetIp: "10.100.1.5", targetPort: 8080 })
      expect(competition.status).toBe("queued")
      expect(competition.purpose).toBe("competition")
      expect(competition.teamId).toBe(team1Id)

      // 4. 元の rehearsal が canceled になっていることも直接確認する。
      const jobs = yield* BenchJobRepo
      const found = yield* jobs.findById(rehearsal.id)
      expect(Option.isSome(found)).toBe(true)
      if (Option.isSome(found)) {
        expect(found.value.status).toBe("canceled")
      }
    }).pipe(Effect.provide(testLayer("preparing")))
  )
})

describe("cancelBench", () => {
  const jobId = BenchJobId.make("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")

  it.effect("自チームの queued ジョブは canceled になる", () =>
    Effect.gen(function* () {
      const job = yield* cancelBench({ user: user1, jobId })
      expect(job.status).toBe("canceled")
    }).pipe(
      Effect.provide(
        testLayer("running", [queuedJob({ id: jobId, teamId: team1Id, targetIp: "10.100.1.9", now: 1000 })])
      )
    )
  )

  it.effect("running のジョブは CannotCancelRunning", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(cancelBench({ user: user1, jobId }))
      expect(exit).toStrictEqual(Exit.fail(new CannotCancelRunning({ jobId })))
    }).pipe(
      Effect.provide(
        testLayer("running", [
          runningJobAt({ id: jobId, teamId: team1Id, targetIp: "10.100.1.9", enqueuedAt: 1000, now: 2000 })
        ])
      )
    )
  )

  it.effect("他チームのジョブは Forbidden", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(cancelBench({ user: user1, jobId }))
      expect(exit).toStrictEqual(Exit.fail(new Forbidden()))
    }).pipe(
      Effect.provide(
        testLayer("running", [queuedJob({ id: jobId, teamId: team2Id, targetIp: "10.100.2.9", now: 1000 })])
      )
    )
  )

  it.effect("存在しない jobId は Forbidden", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(cancelBench({ user: user1, jobId }))
      expect(exit).toStrictEqual(Exit.fail(new Forbidden()))
    }).pipe(Effect.provide(testLayer("running", [])))
  )
})

describe("pollNextJob", () => {
  it.effect("queued 2 本(team1 が古い)→ team1 が running で返り、次は None", () =>
    Effect.gen(function* () {
      const first = yield* pollNextJob
      expect(Option.isSome(first)).toBe(true)
      if (Option.isSome(first)) {
        expect(first.value.teamId).toBe(team1Id)
        expect(first.value.status).toBe("running")
      }
      const second = yield* pollNextJob
      expect(second).toStrictEqual(Option.none())
    }).pipe(
      Effect.provide(
        testLayer("running", [
          queuedJob({
            id: BenchJobId.make("cccccccc-cccc-cccc-cccc-cccccccccccc"),
            teamId: team1Id,
            targetIp: "10.100.1.9",
            now: 1000
          }),
          queuedJob({
            id: BenchJobId.make("dddddddd-dddd-dddd-dddd-dddddddddddd"),
            teamId: team2Id,
            targetIp: "10.100.2.9",
            now: 2000
          })
        ])
      )
    )
  )
})

describe("reportProgress", () => {
  const jobId = BenchJobId.make("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee")

  it.effect("running なら lastProgressAt を更新する", () =>
    Effect.gen(function* () {
      const before = runningJobAt({ id: jobId, teamId: team1Id, targetIp: "10.100.1.9", enqueuedAt: 1000, now: 2000 })
      yield* TestClock.setTime(3000)
      const updated = yield* reportProgress({ jobId })
      expect(Option.isSome(updated.lastProgressAt)).toBe(true)
      if (Option.isSome(updated.lastProgressAt) && Option.isSome(before.lastProgressAt)) {
        expect(updated.lastProgressAt.value).toBeGreaterThan(before.lastProgressAt.value)
      }
    }).pipe(
      Effect.provide(
        testLayer("running", [
          runningJobAt({ id: jobId, teamId: team1Id, targetIp: "10.100.1.9", enqueuedAt: 1000, now: 2000 })
        ])
      )
    )
  )

  it.effect("queued なら InvalidJobTransition", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(reportProgress({ jobId }))
      expect(exit).toStrictEqual(
        Exit.fail(new InvalidJobTransition({ jobId, from: "queued", action: "recordProgress" }))
      )
    }).pipe(
      Effect.provide(
        testLayer("running", [queuedJob({ id: jobId, teamId: team1Id, targetIp: "10.100.1.9", now: 1000 })])
      )
    )
  )
})

describe("reportFinish", () => {
  const jobId = BenchJobId.make("ffffffff-ffff-ffff-ffff-ffffffffffff")

  it.effect("running → finished(score/passed 保存)", () =>
    Effect.gen(function* () {
      const finished = yield* reportFinish({ jobId, score: 100, passed: true })
      expect(finished.status).toBe("finished")
      expect(finished.score).toStrictEqual(Option.some(100))
      expect(finished.passed).toStrictEqual(Option.some(true))
    }).pipe(
      Effect.provide(
        testLayer("running", [
          runningJobAt({ id: jobId, teamId: team1Id, targetIp: "10.100.1.9", enqueuedAt: 1000, now: 2000 })
        ])
      )
    )
  )

  it.effect("queued に対する finish は InvalidJobTransition", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(reportFinish({ jobId, score: 100, passed: true }))
      expect(exit).toStrictEqual(Exit.fail(new InvalidJobTransition({ jobId, from: "queued", action: "finish" })))
    }).pipe(
      Effect.provide(
        testLayer("running", [queuedJob({ id: jobId, teamId: team1Id, targetIp: "10.100.1.9", now: 1000 })])
      )
    )
  )
})

describe("sweepTimedOutJobs", () => {
  const staleId = BenchJobId.make("11111111-2222-3333-4444-555555555555")
  const freshId = BenchJobId.make("66666666-7777-8888-9999-000000000000")
  const jobTimeoutMillis = 600_000

  it.effect("進捗途絶(10 分超)の running は failed(timeout) になり、直近進捗ありは無傷", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(700_000)
      const count = yield* sweepTimedOutJobs
      expect(count).toBe(1)

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
    }).pipe(
      Effect.provide(
        testLayer(
          "running",
          [
            new BenchJob({
              ...runningJobAt({ id: staleId, teamId: team1Id, targetIp: "10.100.1.9", enqueuedAt: 0, now: 0 }),
              lastProgressAt: Option.some(0)
            }),
            new BenchJob({
              ...runningJobAt({ id: freshId, teamId: team2Id, targetIp: "10.100.2.9", enqueuedAt: 0, now: 0 }),
              lastProgressAt: Option.some(650_000)
            })
          ],
          jobTimeoutMillis
        )
      )
    )
  )

  it.effect("reportFinish 済みのジョブは cutoff 条件を満たしても failed にならない(件数 0)", () =>
    Effect.gen(function* () {
      const finished = yield* reportFinish({ jobId: staleId, score: 100, passed: true })
      expect(finished.status).toBe("finished")

      yield* TestClock.setTime(700_000)
      const count = yield* sweepTimedOutJobs
      expect(count).toBe(0)

      const jobs = yield* BenchJobRepo
      const after = yield* jobs.findById(staleId)
      expect(Option.isSome(after)).toBe(true)
      if (Option.isSome(after)) {
        expect(after.value.status).toBe("finished")
        expect(after.value.score).toStrictEqual(Option.some(100))
      }
    }).pipe(
      Effect.provide(
        testLayer(
          "running",
          [
            new BenchJob({
              ...runningJobAt({ id: staleId, teamId: team1Id, targetIp: "10.100.1.9", enqueuedAt: 0, now: 0 }),
              lastProgressAt: Option.some(0)
            })
          ],
          jobTimeoutMillis
        )
      )
    )
  )
})

describe("状態遷移の競合(TOCTOU 回帰)", () => {
  it.effect("sweep で failed になったジョブへの reportFinish は InvalidJobTransition で失敗し failed のまま", () =>
    Effect.gen(function* () {
      const staleId = BenchJobId.make("77777777-8888-9999-aaaa-bbbbbbbbbbbb")
      yield* TestClock.setTime(700_000)
      const count = yield* sweepTimedOutJobs
      expect(count).toBe(1)

      const exit = yield* Effect.exit(reportFinish({ jobId: staleId, score: 100, passed: true }))
      expect(exit).toStrictEqual(
        Exit.fail(new InvalidJobTransition({ jobId: staleId, from: "failed", action: "finish" }))
      )

      const jobs = yield* BenchJobRepo
      const after = yield* jobs.findById(staleId)
      expect(Option.isSome(after)).toBe(true)
      if (Option.isSome(after)) {
        expect(after.value.status).toBe("failed")
      }
    }).pipe(
      Effect.provide(
        testLayer(
          "running",
          [
            new BenchJob({
              ...runningJobAt({
                id: BenchJobId.make("77777777-8888-9999-aaaa-bbbbbbbbbbbb"),
                teamId: team1Id,
                targetIp: "10.100.1.9",
                enqueuedAt: 0,
                now: 0
              }),
              lastProgressAt: Option.some(0)
            })
          ],
          600_000
        )
      )
    )
  )

  it.effect("dequeue で running になったジョブへの cancelBench は CannotCancelRunning で失敗し running のまま", () =>
    Effect.gen(function* () {
      const queuedId = BenchJobId.make("99999999-aaaa-bbbb-cccc-dddddddddddd")

      const dequeued = yield* pollNextJob
      expect(Option.isSome(dequeued)).toBe(true)
      if (Option.isSome(dequeued)) {
        expect(dequeued.value.status).toBe("running")
      }

      const exit = yield* Effect.exit(cancelBench({ user: user1, jobId: queuedId }))
      expect(exit).toStrictEqual(Exit.fail(new CannotCancelRunning({ jobId: queuedId })))

      const jobs = yield* BenchJobRepo
      const after = yield* jobs.findById(queuedId)
      expect(Option.isSome(after)).toBe(true)
      if (Option.isSome(after)) {
        expect(after.value.status).toBe("running")
      }
    }).pipe(
      Effect.provide(
        testLayer("running", [
          queuedJob({
            id: BenchJobId.make("99999999-aaaa-bbbb-cccc-dddddddddddd"),
            teamId: team1Id,
            targetIp: "10.100.1.9",
            now: 1000
          })
        ])
      )
    )
  )
})
