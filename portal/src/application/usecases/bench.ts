import { Clock, Effect, Either, Option } from "effect"
import { cancelJob, checkEnqueueAllowed, finishJob, newJob, recordProgress } from "../../domain/benchJob.js"
import { ContestNotRunning } from "../../domain/errors.js"
import type { User } from "../../domain/user.js"
import { BenchJobId } from "../../domain/ids.js"
import { Forbidden, NotInTeam } from "../errors.js"
import { BenchJobRepo, ContestRepo, RunnerConfig, TeamRepo, UuidGen } from "../ports.js"

// repo 取得 → domain 遷移関数(Either.match で E チャネルへ)→ save、が全ユース
// ケース共通の形。ports.ts のメソッドはすべて R=never なので、この関数群も
// R=never のまま(Layer 合成は main.ts の 1 箇所に集約する)。

export const enqueueBench = (args: { user: User; targetIp: string; targetPort: number }) =>
  Effect.gen(function* () {
    // Contest が未作成(getCurrent = None)の場合も「準備中」として扱う。
    const contest = yield* ContestRepo.pipe(
      Effect.flatMap((r) => r.getCurrent),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new ContestNotRunning({ status: "preparing" })),
          onSome: Effect.succeed
        })
      )
    )

    const team = yield* TeamRepo.pipe(
      Effect.flatMap((r) => r.findByUserId(args.user.id)),
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new NotInTeam()), onSome: Effect.succeed }))
    )

    const jobs = yield* BenchJobRepo

    // activeJobCountForTeam の最終判定は insertIfAllowed がトランザクション内
    // で行う(ここでの 0 は contest/subnet 検証のためだけの呼び出し)。
    yield* Either.match(
      checkEnqueueAllowed({
        contest,
        activeJobCountForTeam: 0,
        teamId: team.id,
        teamNumber: team.teamNumber,
        targetIp: args.targetIp
      }),
      { onLeft: Effect.fail, onRight: Effect.succeed }
    )

    const uuidGen = yield* UuidGen
    const id = BenchJobId.make(yield* uuidGen.next)
    const now = yield* Clock.currentTimeMillis
    return yield* jobs.insertIfAllowed(
      newJob({ id, teamId: team.id, targetIp: args.targetIp, targetPort: args.targetPort, now })
    )
  })

export const cancelBench = (args: { user: User; jobId: BenchJobId }) =>
  Effect.gen(function* () {
    const team = yield* TeamRepo.pipe(
      Effect.flatMap((r) => r.findByUserId(args.user.id)),
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new NotInTeam()), onSome: Effect.succeed }))
    )

    const jobs = yield* BenchJobRepo
    const job = yield* jobs.findById(args.jobId).pipe(
      // 存在しないジョブは「他チームのジョブ」と同じ Forbidden として扱う
      // (ジョブ ID の存在有無を漏らさない)。
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new Forbidden()), onSome: Effect.succeed }))
    )

    if (job.teamId !== team.id) {
      return yield* Effect.fail(new Forbidden())
    }

    const canceled = yield* Either.match(cancelJob(job), { onLeft: Effect.fail, onRight: Effect.succeed })
    yield* jobs.save(canceled)
    return canceled
  })

export const pollNextJob = Effect.gen(function* () {
  const jobs = yield* BenchJobRepo
  const now = yield* Clock.currentTimeMillis
  return yield* jobs.dequeueNextQueued(now)
})

export const reportProgress = (args: { jobId: BenchJobId }) =>
  Effect.gen(function* () {
    const jobs = yield* BenchJobRepo
    const job = yield* jobs.findById(args.jobId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.dieMessage(`reportProgress: BenchJob ${args.jobId} not found`),
          onSome: Effect.succeed
        })
      )
    )
    const now = yield* Clock.currentTimeMillis
    const updated = yield* Either.match(recordProgress(job, now), { onLeft: Effect.fail, onRight: Effect.succeed })
    yield* jobs.save(updated)
    return updated
  })

export const reportFinish = (args: { jobId: BenchJobId; score: number; passed: boolean }) =>
  Effect.gen(function* () {
    const jobs = yield* BenchJobRepo
    const job = yield* jobs.findById(args.jobId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.dieMessage(`reportFinish: BenchJob ${args.jobId} not found`),
          onSome: Effect.succeed
        })
      )
    )
    const now = yield* Clock.currentTimeMillis
    const finished = yield* Either.match(finishJob(job, { score: args.score, passed: args.passed }, now), {
      onLeft: Effect.fail,
      onRight: Effect.succeed
    })
    yield* jobs.save(finished)
    return finished
  })

export const sweepTimedOutJobs = Effect.gen(function* () {
  const jobs = yield* BenchJobRepo
  const config = yield* RunnerConfig
  const now = yield* Clock.currentTimeMillis
  return yield* jobs.failTimedOutJobs(now - config.jobTimeoutMillis, now)
})
