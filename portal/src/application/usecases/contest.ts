import { Clock, Effect, Either, Option } from "effect"
import { beginFinalization, finishContest, startContest } from "../../domain/contest.js"
import { ContestNotFound } from "../errors.js"
import { BenchJobRepo, ContestRepo, RepoError } from "../ports.js"

// Task 3: 未指定の /api/contest は「今表示すべき contest」(getDisplay)を返す。
// running/finalizing 優先、次に最新 finished、最後に preparing(準備中は
// 前回結果を保持するため優先度が低い)。canceled は候補外。0 件は 404。
export const getCurrentContest = ContestRepo.pipe(
  Effect.flatMap((repo) => repo.getDisplay),
  Effect.flatMap(Option.match({ onNone: () => Effect.fail(new ContestNotFound()), onSome: Effect.succeed }))
)

// POST /api/admin/contest/start は「今 operational な contest」を起点に
// preparing -> running 遷移させる。楽観ロック(saveIfRevision)は revision を
// +1 した Contest と現行 revision を突き合わせる。競合(別 admin が同時に
// 状態を変えた)は RepoError に畳んで 500 にする(現行 UI は再取得で復旧)。
export const startContestUsecase = Effect.gen(function* () {
  const repo = yield* ContestRepo
  const jobs = yield* BenchJobRepo
  const contest = yield* repo.getOperational.pipe(
    Effect.flatMap(Option.match({ onNone: () => Effect.fail(new ContestNotFound()), onSome: Effect.succeed }))
  )
  const now = yield* Clock.currentTimeMillis
  const started = yield* Either.match(startContest(contest, now), { onLeft: Effect.fail, onRight: Effect.succeed })
  // preparing 中に admin が enqueue した rehearsal が queued のまま残ると、
  // running 遷移後の benchJobRepo.insertIfAllowed の NOT EXISTS (purpose
  // 非依存) が同一チームの competition enqueue を永久にブロックする。
  // saveIfRevision の前に一括キャンセルしておく。
  //
  // Scope of the cancel: この一括キャンセルは status='queued' の rehearsal
  // のみに効く。既に running の rehearsal はここでは触らない(runner が
  // 走行中のジョブを canceled にすると reportProgress/reportFinish が
  // InvalidJobTransition で落ち、runner 側の遺物処理を汚す)。running な
  // rehearsal が生き残ると、そのチームだけ rehearsal 完了/タイムアウト
  // (RunnerConfig.jobTimeoutMillis)までは competition enqueue が
  // TeamJobAlreadyQueued で弾かれる過渡状態が残る。Task 10 の guarded_start
  // Operation は「in-flight rehearsal が無いこと」を readiness の前提条件
  // として要求するので、その時点でこの過渡状態はそもそも観測不能になる。
  //
  // TOCTOU sweep: cancel と save は別トランザクションで、間に別 admin が
  // rehearsal を enqueue すると orphan として残り(runner は
  // dequeueNextQueued の purpose フィルタで拾わない、insertIfAllowed の
  // team ガードは purpose 非依存で永久ブロック)、手動 UPDATE でしか
  // 復旧できない状態になる。save 成功後にもう一度 cancel を呼んで
  // window を閉じる(2 回目は冪等)。running 遷移後の enqueueBench は
  // checkEnqueueAllowed が rehearsal を弾くので、post-save 以降に新規
  // orphan が発生することはない。
  //
  // Non-atomicity note: cancel と save は別トランザクションなので
  // saveIfRevision が revision conflict で失敗すると "rehearsal は
  // canceled だが contest はまだ preparing" という中間状態が残る。ただし
  // 次の startContestUsecase 呼び出しが cancel-first で再度 sweep するため
  // eventually consistent で回復する:
  //   - retry 1: cancel(no-op, 既に canceled)→ save(成功)
  //   - retry 2: 別 admin が start 済みなら InvalidContestTransition で
  //     早期 fail、その admin の cancel 処理が新規 rehearsal を掃除する
  //   - どちらの経路でも admin は re-enqueue で復旧可能
  // Task 10 の guarded_start Operation が durable step として置き換わる
  // タイミングでこの非同期性は消える。
  yield* jobs.cancelQueuedRehearsalsForContest(contest.id)
  const saved = yield* repo.saveIfRevision(started, contest.revision).pipe(
    Effect.catchTag("ContestRevisionConflict", (cause) =>
      Effect.logWarning(
        `startContestUsecase revision conflict: contestId=${contest.id} expected=${cause.expected} actual=${cause.actual}`
      ).pipe(Effect.flatMap(() => Effect.fail(new RepoError({ cause }))))
    )
  )
  // TOCTOU close: cancel と save の間に enqueue された rehearsal を確実に掃く。
  yield* jobs.cancelQueuedRehearsalsForContest(contest.id)
  return saved
})

// POST /api/admin/contest/finish は Task 1 の互換ブリッジ層。running ->
// finalizing (beginFinalization) -> finished (finishContest) を domain
// 側で連続適用し、単一の saveIfRevision で永続化する(finished の revision
// は元 +2、期待 revision は遷移前の元 revision で楽観ロック)。並行 admin
// 操作で revision がズレていれば ContestRevisionConflict → RepoError で
// 500 に畳んで retry させる。Task 11 で durable finalization Operation に
// 置き換え、このブリッジは削除される。
export const finishContestUsecase = Effect.gen(function* () {
  const repo = yield* ContestRepo
  const contest = yield* repo.getOperational.pipe(
    Effect.flatMap(Option.match({ onNone: () => Effect.fail(new ContestNotFound()), onSome: Effect.succeed }))
  )
  const now = yield* Clock.currentTimeMillis
  const finalizing = yield* Either.match(beginFinalization(contest, now), {
    onLeft: Effect.fail,
    onRight: Effect.succeed
  })
  const finished = yield* Either.match(finishContest(finalizing, now), {
    onLeft: Effect.fail,
    onRight: Effect.succeed
  })
  return yield* repo.saveIfRevision(finished, contest.revision).pipe(
    Effect.catchTag("ContestRevisionConflict", (cause) =>
      Effect.logWarning(
        `finishContestUsecase revision conflict: contestId=${contest.id} expected=${cause.expected} actual=${cause.actual}`
      ).pipe(Effect.flatMap(() => Effect.fail(new RepoError({ cause }))))
    )
  )
})
