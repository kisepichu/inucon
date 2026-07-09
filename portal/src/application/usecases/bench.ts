import { Clock, Effect, Either, Option } from "effect"
import { checkEnqueueAllowed, newJob } from "../../domain/benchJob.js"
import { ContestNotRunning } from "../../domain/errors.js"
import type { User } from "../../domain/user.js"
import { BenchJobId, InstanceId, TeamId } from "../../domain/ids.js"
import { Forbidden, InstanceNotFound, NotInTeam } from "../errors.js"
import { BenchJobRepo, ContestRepo, InstanceRepo, RunnerConfig, TeamRepo, UuidGen } from "../ports.js"

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

// progress は logChunk 省略時(既存呼び出し互換)は appendLog("") の no-op になる。
export const reportProgress = (args: { jobId: BenchJobId; logChunk?: string }) =>
  Effect.gen(function* () {
    const jobs = yield* BenchJobRepo
    const now = yield* Clock.currentTimeMillis
    const job = yield* jobs.recordProgressIfRunning(args.jobId, now)
    yield* jobs.appendLog(args.jobId, args.logChunk ?? "")
    return job
  })

// errorMessage が付いている(実行自体の失敗: バイナリ異常終了等)場合は
// failIfRunning、無ければ finishIfRunning(score/passed を保存)。どちらも
// running でなければ InvalidJobTransition。logTail は省略時(既存呼び出し
// 互換)は appendLog("") の no-op になる。
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
    yield* jobs.appendLog(args.jobId, args.logTail ?? "")
    return job
  })

export const sweepTimedOutJobs = Effect.gen(function* () {
  const jobs = yield* BenchJobRepo
  const config = yield* RunnerConfig
  const now = yield* Clock.currentTimeMillis
  return yield* jobs.failTimedOutJobs(now - config.jobTimeoutMillis, now)
})

// POST /api/bench-jobs: instanceId 指定時は InstanceRepo で privateIp を解決し
// targetPort=80 固定にする(スペック §2 bench)。キュー不変条件の判定・INSERT
// は既存の enqueueBench(targetIp/targetPort ベース、Task 3 実装済み)に委譲し
// 対象解決のみをここで追加する(二重実装を避ける)。
export const enqueueBenchJob = (args: {
  user: User
  target: { instanceId: InstanceId } | { targetIp: string; targetPort: number }
}) =>
  Effect.gen(function* () {
    if ("instanceId" in args.target) {
      const team = yield* TeamRepo.pipe(
        Effect.flatMap((r) => r.findByUserId(args.user.id)),
        Effect.flatMap(Option.match({ onNone: () => Effect.fail(new NotInTeam()), onSome: Effect.succeed }))
      )
      const instances = yield* InstanceRepo
      const instance = yield* instances.findById(args.target.instanceId).pipe(
        Effect.flatMap(Option.match({ onNone: () => Effect.fail(new InstanceNotFound()), onSome: Effect.succeed }))
      )
      // 他チームのインスタンス指定をそのまま enqueueBench の subnet 検証に
      // 流すと、TargetIpOutOfSubnet のエラーボディに解決済みの他チーム
      // privateIp が載って漏れる。解決結果を使う前にチーム所属を突き合わせ、
      // 不一致は Forbidden で落とす(privateIp は返さない)。
      if (instance.teamId !== team.id) {
        return yield* Effect.fail(new Forbidden())
      }
      return yield* enqueueBench({ user: args.user, targetIp: instance.privateIp, targetPort: 80 })
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

// POST /api/runner/jobs/poll: pollNextJob(既存)の結果に、現在の Contest の
// problemKey を載せて RunnerJob 形に組み立てる(ランナーが問題アダプタを
// 選ぶための情報)。Contest が存在して running のときだけ dequeue する
// (設計判断: 本家同様、コンテスト終了でキューは閉じる。enqueue 済みの
// queued ジョブが finished 後に実行され始めることを防ぐ)。Contest 不在 /
// preparing / finished では dequeue せず None(ジョブを running 化させない)。
export const pollNextRunnerJob = Effect.gen(function* () {
  const contests = yield* ContestRepo
  const contest = yield* contests.getCurrent.pipe(
    Effect.map(Option.filter((c) => c.status === "running"))
  )
  return yield* Option.match(contest, {
    onNone: () => Effect.succeed(Option.none<RunnerJobView>()),
    onSome: (c) =>
      pollNextJob.pipe(
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
  })
})

// GET /api/bench-jobs?teamId=: スコア・状態の一覧は全員可(ログは含まない)。
export const listBenchJobs = (args: { teamId: TeamId }) =>
  BenchJobRepo.pipe(Effect.flatMap((repo) => repo.listByTeam(args.teamId, 50)))

// GET /api/bench-jobs/:id: ログ含む詳細。自チーム or admin のみ(cancelBench
// と同様、存在しないジョブも Forbidden として扱い ID の存在有無を漏らさない)。
export const getBenchJobDetail = (args: { user: User; jobId: BenchJobId }) =>
  Effect.gen(function* () {
    const jobs = yield* BenchJobRepo
    const job = yield* jobs.findById(args.jobId).pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new Forbidden()), onSome: Effect.succeed }))
    )

    if (!args.user.isAdmin) {
      const teams = yield* TeamRepo
      const team = yield* teams.findByUserId(args.user.id)
      const isOwnTeam = Option.isSome(team) && team.value.id === job.teamId
      if (!isOwnTeam) {
        return yield* Effect.fail(new Forbidden())
      }
    }

    const log = yield* jobs.getLog(args.jobId)
    return { job, log }
  })
