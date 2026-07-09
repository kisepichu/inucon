import { it } from "@effect/vitest"
import { Effect, Either, Exit, Layer, Option, TestClock } from "effect"
import { describe, expect } from "vitest"
import { BenchJob, newJob, startJob } from "../../src/domain/benchJob.js"
import { Contest } from "../../src/domain/contest.js"
import {
  CannotCancelRunning,
  ContestNotRunning,
  InvalidJobTransition,
  TargetIpOutOfSubnet,
  TeamJobAlreadyQueued
} from "../../src/domain/errors.js"
import { BenchJobId, ContestId, TeamId, UserId } from "../../src/domain/ids.js"
import { Team } from "../../src/domain/team.js"
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
import {
  makeBenchJobRepoTest,
  makeContestRepoTest,
  makeTeamRepoTest,
  RunnerConfigTest,
  UuidGenTest
} from "../support/inMemory.js"

const contestId = ContestId.make("11111111-1111-1111-1111-111111111111")
const team1Id = TeamId.make("22222222-2222-2222-2222-222222222222")
const team2Id = TeamId.make("33333333-3333-3333-3333-333333333333")
const user1Id = UserId.make("44444444-4444-4444-4444-444444444444")
const user2Id = UserId.make("55555555-5555-5555-5555-555555555555")
const noTeamUserId = UserId.make("66666666-6666-6666-6666-666666666666")

const team1 = new Team({ id: team1Id, name: "team1", teamNumber: 1 })
const team2 = new Team({ id: team2Id, name: "team2", teamNumber: 2 })
const user1 = new User({ id: user1Id, githubId: 1, githubLogin: "u1", displayName: "User 1", isAdmin: false })
const noTeamUser = new User({
  id: noTeamUserId,
  githubId: 3,
  githubLogin: "u3",
  displayName: "User 3",
  isAdmin: false
})

const makeContest = (status: Contest["status"]) =>
  new Contest({ id: contestId, name: "INUCON", problemKey: "problem-1", status })

// startJob は queued な BenchJob からのみ成功するので、テストデータ作りは
// 常に newJob() から作った queued ジョブを起点にする。
const runningJobAt = (args: { id: BenchJobId; teamId: TeamId; targetIp: string; enqueuedAt: number; now: number }) =>
  Either.getOrThrow(
    startJob(
      newJob({ id: args.id, teamId: args.teamId, targetIp: args.targetIp, targetPort: 8080, now: args.enqueuedAt }),
      args.now
    )
  )

const teamRepoLayer = makeTeamRepoTest({
  teams: [team1, team2],
  memberships: [
    { userId: user1Id, teamId: team1Id },
    { userId: user2Id, teamId: team2Id }
  ]
})

const testLayer = (
  contestStatus: Contest["status"],
  jobs: ReadonlyArray<ReturnType<typeof newJob>> = [],
  jobTimeoutMillis = 600_000
) =>
  Layer.mergeAll(
    UuidGenTest,
    makeContestRepoTest(Option.some(makeContest(contestStatus))),
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
    }).pipe(Effect.provide(testLayer("running")))
  )

  it.effect("contest が preparing なら ContestNotRunning", () =>
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
          newJob({
            id: BenchJobId.make("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
            teamId: team1Id,
            targetIp: "10.100.1.9",
            targetPort: 8080,
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

describe("cancelBench", () => {
  const jobId = BenchJobId.make("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")

  it.effect("自チームの queued ジョブは canceled になる", () =>
    Effect.gen(function* () {
      const job = yield* cancelBench({ user: user1, jobId })
      expect(job.status).toBe("canceled")
    }).pipe(
      Effect.provide(
        testLayer("running", [
          newJob({ id: jobId, teamId: team1Id, targetIp: "10.100.1.9", targetPort: 8080, now: 1000 })
        ])
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
        testLayer("running", [
          newJob({ id: jobId, teamId: team2Id, targetIp: "10.100.2.9", targetPort: 8080, now: 1000 })
        ])
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
          newJob({
            id: BenchJobId.make("cccccccc-cccc-cccc-cccc-cccccccccccc"),
            teamId: team1Id,
            targetIp: "10.100.1.9",
            targetPort: 8080,
            now: 1000
          }),
          newJob({
            id: BenchJobId.make("dddddddd-dddd-dddd-dddd-dddddddddddd"),
            teamId: team2Id,
            targetIp: "10.100.2.9",
            targetPort: 8080,
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
        testLayer("running", [
          newJob({ id: jobId, teamId: team1Id, targetIp: "10.100.1.9", targetPort: 8080, now: 1000 })
        ])
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
        testLayer("running", [
          newJob({ id: jobId, teamId: team1Id, targetIp: "10.100.1.9", targetPort: 8080, now: 1000 })
        ])
      )
    )
  )
})

describe("sweepTimedOutJobs", () => {
  const staleId = BenchJobId.make("11111111-2222-3333-4444-555555555555")
  const freshId = BenchJobId.make("66666666-7777-8888-9999-000000000000")
  const jobTimeoutMillis = 600_000 // 10 分

  it.effect("進捗途絶(10 分超)の running は failed(timeout) になり、直近進捗ありは無傷", () =>
    Effect.gen(function* () {
      // now=700_000, timeout=600_000 → cutoff=100_000
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
              lastProgressAt: Option.some(0) // 700_000 - 0 > timeout → 対象
            }),
            new BenchJob({
              ...runningJobAt({ id: freshId, teamId: team2Id, targetIp: "10.100.2.9", enqueuedAt: 0, now: 0 }),
              lastProgressAt: Option.some(650_000) // 700_000 - 650_000 < timeout → 無傷
            })
          ],
          jobTimeoutMillis
        )
      )
    )
  )

  it.effect("reportFinish 済みのジョブは cutoff 条件を満たしても failed にならない(件数 0)", () =>
    Effect.gen(function* () {
      // running(lastProgressAt=0)のジョブを先に finish してから sweep する。
      // 判定と更新が原子的でない実装だと、finished を failed で上書きしうる
      // 競合(TOCTOU)の代表ケース。
      const finished = yield* reportFinish({ jobId: staleId, score: 100, passed: true })
      expect(finished.status).toBe("finished")

      yield* TestClock.setTime(700_000) // cutoff=100_000、lastProgressAt=0 < cutoff
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

// reportProgress/reportFinish/cancel を「判定+更新」を単一の原子的操作に
// 寄せた(recordProgressIfRunning/finishIfRunning/cancelIfQueued)ことの回帰
// テスト。sweep や dequeue が先にジョブの状態を変えてしまうケースで、後続の
// ユースケースが古い状態を前提に上書きしないことを確認する。
describe("状態遷移の競合(TOCTOU 回帰)", () => {
  it.effect("sweep で failed になったジョブへの reportFinish は InvalidJobTransition で失敗し failed のまま", () =>
    Effect.gen(function* () {
      const staleId = BenchJobId.make("77777777-8888-9999-aaaa-bbbbbbbbbbbb")
      // now=700_000, timeout=600_000 → cutoff=100_000。lastProgressAt=0 は対象。
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
          newJob({
            id: BenchJobId.make("99999999-aaaa-bbbb-cccc-dddddddddddd"),
            teamId: team1Id,
            targetIp: "10.100.1.9",
            targetPort: 8080,
            now: 1000
          })
        ])
      )
    )
  )
})
