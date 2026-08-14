import { Clock, Effect, Either, Option } from "effect"
import type { BenchJob, BenchJobPurpose } from "../../domain/benchJob.js"
import { checkEnqueueAllowed, newJob } from "../../domain/benchJob.js"
import { ContestNotRunning } from "../../domain/errors.js"
import type { Contest } from "../../domain/contest.js"
import type { User } from "../../domain/user.js"
import type { ContestId } from "../../domain/ids.js"
import { BenchJobId, InstanceId, TeamId } from "../../domain/ids.js"
import { Forbidden, InstanceNotFound, InstanceNotRunning, NotInTeam } from "../errors.js"
import { BenchJobRepo, ContestRepo, InstanceRepo, RunnerConfig, TeamRepo, UuidGen } from "../ports.js"

// Task 3: enqueue は「operational な contest を取得 → その contest スコープで
// team/instance を突き合わせる」形。preparing なら rehearsal、running なら
// competition の purpose を自動で決める(現行 UI は purpose を選ばない)。
// enqueueBench 内部で domain.checkEnqueueAllowed が purpose と contest.status
// の整合を最終判定する。

export const enqueueBench = (args: {
  user: User
  targetIp: string
  targetPort: number
  requireRunningInstance?: { instanceId: InstanceId }
  // enqueueBenchJob が既に operational contest を解決している場合は流用して
  // getOperational の二重呼びを避ける(caller-defined snapshot を使うことで
  // running→finalizing 過渡でも同じ contest.status を判定に使える)。
  contest?: Contest
}) =>
  Effect.gen(function* () {
    // 0 contest の状態は「未作成 = 準備中」として ContestNotRunning。
    const contest =
      args.contest ??
      (yield* ContestRepo.pipe(
        Effect.flatMap((r) => r.getOperational),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new ContestNotRunning({ status: "preparing" })),
            onSome: Effect.succeed
          })
        )
      ))

    const team = yield* TeamRepo.pipe(
      Effect.flatMap((r) => r.findByUserId(contest.id, args.user.id)),
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new NotInTeam()), onSome: Effect.succeed }))
    )

    // finalizing はキューをクローズしている(scheduler が新規 dequeue しない)。
    // ここで先に落とさないと下の三項演算で rehearsal 判定になり、admin が
    // 通ってしまったあと checkEnqueueAllowed が「rehearsal は preparing のみ」
    // で拒否するという遠回りな失敗経路になる。ユーザに直接理由を返す。
    if (contest.status === "finalizing") {
      return yield* Effect.fail(new ContestNotRunning({ status: "finalizing" }))
    }

    // preparing での rehearsal は admin のみ許可(参加者は running まで待つ)。
    // ここでは「preparing 中の enqueue は admin のみ」で弾き、後段の checkEnqueue
    // Allowed が purpose と status の対応を最終判定する。
    const purpose: BenchJobPurpose = contest.status === "running" ? "competition" : "rehearsal"
    if (purpose === "rehearsal" && !args.user.isAdmin) {
      return yield* Effect.fail(new ContestNotRunning({ status: contest.status }))
    }

    const jobs = yield* BenchJobRepo

    yield* Either.match(
      checkEnqueueAllowed({
        contest,
        purpose,
        teamNumber: team.teamNumber,
        targetIp: args.targetIp
      }),
      { onLeft: Effect.fail, onRight: Effect.succeed }
    )

    const uuidGen = yield* UuidGen
    const id = BenchJobId.make(yield* uuidGen.next)
    const now = yield* Clock.currentTimeMillis
    return yield* jobs.insertIfAllowed(
      newJob({
        id,
        contestId: contest.id,
        teamId: team.id,
        targetIp: args.targetIp,
        targetPort: args.targetPort,
        purpose,
        now
      }),
      args.requireRunningInstance === undefined
        ? undefined
        : { instanceId: args.requireRunningInstance.instanceId, teamId: team.id }
    )
  })

export const cancelBench = (args: { user: User; jobId: BenchJobId }) =>
  Effect.gen(function* () {
    const jobs = yield* BenchJobRepo
    const job = yield* jobs.findById(args.jobId).pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new Forbidden()), onSome: Effect.succeed }))
    )

    // 対象 Job の contest scope で team 所属を再判定(admin は素通り)。
    if (!args.user.isAdmin) {
      const teams = yield* TeamRepo
      const team = yield* teams.findByUserId(job.contestId, args.user.id).pipe(
        Effect.flatMap(Option.match({ onNone: () => Effect.fail(new NotInTeam()), onSome: Effect.succeed }))
      )
      if (job.teamId !== team.id) {
        return yield* Effect.fail(new Forbidden())
      }
    }

    return yield* jobs.cancelIfQueued(args.jobId)
  })

// pollNextJob は runner から呼ばれる古い経路(現在は pollNextRunnerJob 経由)。
// contestId + purpose を渡す形に絞り込む(candidate 決定はこの Effect 外側で行う)。
export const pollNextJobFor = (candidate: { contestId: ContestId; purpose: BenchJobPurpose }) =>
  Effect.gen(function* () {
    const jobs = yield* BenchJobRepo
    const now = yield* Clock.currentTimeMillis
    return yield* jobs.dequeueNextQueued(candidate, now)
  })


// progress の logChunk 省略/空文字(ハートビートのみ)は appendLog 自体を
// スキップして不要な DB 書き込みを避ける。
export const reportProgress = (args: { jobId: BenchJobId; logChunk?: string }) =>
  Effect.gen(function* () {
    const jobs = yield* BenchJobRepo
    const now = yield* Clock.currentTimeMillis
    const job = yield* jobs.recordProgressIfRunning(args.jobId, now)
    const chunk = args.logChunk ?? ""
    if (chunk !== "") {
      yield* jobs.appendLog(args.jobId, chunk)
    }
    return job
  })

// errorMessage が付いている(実行自体の失敗: バイナリ異常終了等)場合は
// failIfRunning、無ければ finishIfRunning(score/passed を保存)。
export const reportFinish = (args: {
  jobId: BenchJobId
  score: number
  passed: boolean
  errorMessage?: string | null
  logTail?: string
}) =>
  Effect.gen(function* () {
    const jobs = yield* BenchJobRepo
    const now = yield* Clock.currentTimeMillis
    const errorMessage = args.errorMessage ?? null
    const job = yield* (errorMessage === null
      ? jobs.finishIfRunning(args.jobId, { score: args.score, passed: args.passed }, now)
      : jobs.failIfRunning(args.jobId, errorMessage, now))
    const logTail = args.logTail ?? ""
    if (logTail !== "") {
      yield* jobs.appendLog(args.jobId, logTail)
    }
    return job
  })

export const sweepTimedOutJobs = Effect.gen(function* () {
  const jobs = yield* BenchJobRepo
  const config = yield* RunnerConfig
  const now = yield* Clock.currentTimeMillis
  return yield* jobs.failTimedOutJobs(now - config.jobTimeoutMillis, now)
})

// POST /api/bench-jobs
export const enqueueBenchJob = (args: {
  user: User
  target: { instanceId: InstanceId } | { targetIp: string; targetPort: number }
}) =>
  Effect.gen(function* () {
    if ("instanceId" in args.target) {
      const contest = yield* ContestRepo.pipe(
        Effect.flatMap((r) => r.getOperational),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new ContestNotRunning({ status: "preparing" })),
            onSome: Effect.succeed
          })
        )
      )
      const team = yield* TeamRepo.pipe(
        Effect.flatMap((r) => r.findByUserId(contest.id, args.user.id)),
        Effect.flatMap(Option.match({ onNone: () => Effect.fail(new NotInTeam()), onSome: Effect.succeed }))
      )
      const instances = yield* InstanceRepo
      const instance = yield* instances.findById(args.target.instanceId).pipe(
        Effect.flatMap(Option.match({ onNone: () => Effect.fail(new InstanceNotFound()), onSome: Effect.succeed }))
      )
      // instance が別 contest / 別チームなら privateIp を漏らさず Forbidden。
      if (instance.contestId !== contest.id || instance.teamId !== team.id) {
        return yield* Effect.fail(new Forbidden())
      }
      if (instance.status !== "running") {
        return yield* Effect.fail(new InstanceNotRunning({ instanceId: instance.id }))
      }
      return yield* enqueueBench({
        user: args.user,
        targetIp: instance.privateIp,
        targetPort: 80,
        requireRunningInstance: { instanceId: instance.id },
        contest
      })
    }
    return yield* enqueueBench({
      user: args.user,
      targetIp: args.target.targetIp,
      targetPort: args.target.targetPort
    })
  })

// ランナーの HttpApiClient から見える形(shared.RunnerJob と同形)。
export interface RunnerJobView {
  readonly id: BenchJobId
  readonly teamId: TeamId
  readonly targetIp: string
  readonly targetPort: number
  readonly problemKey: string
}

// POST /api/runner/jobs/poll: 現在の operational contest(preparing/running/
// finalizing)を候補に取り、running なら competition、preparing なら
// rehearsal を dequeue する。finalizing は running ジョブの完了待ちなので
// 新規 dequeue はしない。
export const pollNextRunnerJob = Effect.gen(function* () {
  const contests = yield* ContestRepo
  const contest = yield* contests.getOperational
  return yield* Option.match(contest, {
    onNone: () => Effect.succeed(Option.none<RunnerJobView>()),
    onSome: (c) => {
      const purpose: BenchJobPurpose | null =
        c.status === "running" ? "competition" : c.status === "preparing" ? "rehearsal" : null
      if (purpose === null) return Effect.succeed(Option.none<RunnerJobView>())
      return pollNextJobFor({ contestId: c.id, purpose }).pipe(
        Effect.map(
          Option.map((job) => ({
            id: job.id,
            teamId: job.teamId,
            targetIp: job.targetIp,
            targetPort: job.targetPort,
            problemKey: c.problemKey
          }))
        )
      )
    }
  })
})

// GET /api/bench-jobs?teamId=。表示は「今 display すべき contest」に固定する
// (running/finalizing > 最新 finished > preparing)。finished でも履歴が
// 見えるべきなので getOperational ではなく getDisplay を使う。0 contest は [].
export const listBenchJobs = (args: { teamId: TeamId }) =>
  Effect.gen(function* () {
    const contests = yield* ContestRepo
    const contest = yield* contests.getDisplay
    if (Option.isNone(contest)) return []
    const jobs = yield* BenchJobRepo
    return yield* jobs.listByTeam(contest.value.id, args.teamId, 50)
  })

// GET /api/bench-jobs/:id: ログ含む詳細。自チーム or admin のみ。
export const getBenchJobDetail = (args: { user: User; jobId: BenchJobId }) =>
  Effect.gen(function* () {
    const jobs = yield* BenchJobRepo
    const job = yield* jobs.findById(args.jobId).pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new Forbidden()), onSome: Effect.succeed }))
    )

    if (!args.user.isAdmin) {
      const teams = yield* TeamRepo
      const team = yield* teams.findByUserId(job.contestId, args.user.id)
      const isOwnTeam = Option.isSome(team) && team.value.id === job.teamId
      if (!isOwnTeam) {
        return yield* Effect.fail(new Forbidden())
      }
    }

    const log = yield* jobs.getLog(args.jobId)
    return { job, log }
  })
