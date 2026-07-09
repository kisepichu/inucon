import { Clock, Effect, Either, Option } from "effect"
import { checkEnqueueAllowed, newJob } from "../../domain/benchJob.js"
import { ContestNotRunning } from "../../domain/errors.js"
import type { User } from "../../domain/user.js"
import { BenchJobId } from "../../domain/ids.js"
import { Forbidden, NotInTeam } from "../errors.js"
import { BenchJobRepo, ContestRepo, RunnerConfig, TeamRepo, UuidGen } from "../ports.js"

// enqueue は「repo 取得 → domain 遷移関数(Either.match で E チャネルへ)→
// insertIfAllowed」の形。状態遷移系(cancel/reportProgress/reportFinish/sweep)
// は判定と更新を単一の原子的操作にまとめた port メソッド(cancelIfQueued 等)
// に委譲し、ユースケース側は findById による authz チェックの後にそれを
// 呼ぶだけの薄い形にしている(TOCTOU 回避)。
// ports.ts の各メソッドの R はいずれも never だが、ユースケース自体は
// Context.Tag(ContestRepo/TeamRepo/BenchJobRepo/UuidGen/RunnerConfig)と
// Clock を環境として要求する(Layer 合成は main.ts の 1 箇所に集約する)。

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

    return yield* jobs.cancelIfQueued(args.jobId)
  })

export const pollNextJob = Effect.gen(function* () {
  const jobs = yield* BenchJobRepo
  const now = yield* Clock.currentTimeMillis
  return yield* jobs.dequeueNextQueued(now)
})

export const reportProgress = (args: { jobId: BenchJobId }) =>
  Effect.gen(function* () {
    const jobs = yield* BenchJobRepo
    const now = yield* Clock.currentTimeMillis
    return yield* jobs.recordProgressIfRunning(args.jobId, now)
  })

export const reportFinish = (args: { jobId: BenchJobId; score: number; passed: boolean }) =>
  Effect.gen(function* () {
    const jobs = yield* BenchJobRepo
    const now = yield* Clock.currentTimeMillis
    return yield* jobs.finishIfRunning(args.jobId, { score: args.score, passed: args.passed }, now)
  })

export const sweepTimedOutJobs = Effect.gen(function* () {
  const jobs = yield* BenchJobRepo
  const config = yield* RunnerConfig
  const now = yield* Clock.currentTimeMillis
  return yield* jobs.failTimedOutJobs(now - config.jobTimeoutMillis, now)
})
