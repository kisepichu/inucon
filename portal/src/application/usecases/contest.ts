import { Clock, Effect, Either, Option } from "effect"
import { beginFinalization, finishContest, startContest } from "../../domain/contest.js"
import { ContestNotFound } from "../errors.js"
import { ContestRepo, RepoError } from "../ports.js"

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
  const contest = yield* repo.getOperational.pipe(
    Effect.flatMap(Option.match({ onNone: () => Effect.fail(new ContestNotFound()), onSome: Effect.succeed }))
  )
  const now = yield* Clock.currentTimeMillis
  const started = yield* Either.match(startContest(contest, now), { onLeft: Effect.fail, onRight: Effect.succeed })
  return yield* repo.saveIfRevision(started, contest.revision).pipe(
    Effect.catchTag("ContestRevisionConflict", (cause) => Effect.fail(new RepoError({ cause })))
  )
})

// POST /api/admin/contest/finish は Task 1 の互換ブリッジ層。running ->
// finalizing (beginFinalization) -> finished (finishContest) を 1 tx 内で
// つなぐ(Task 11 で durable finalization Operation に置き換え、このブリッジは
// 削除される)。楽観ロックは 2 段まとめてトランザクション先頭の revision で
// 判定する(saveIfRevision を 2 回呼ぶが、間で他 admin が触ると 2 回目が
// revision conflict になり retry で拾える)。
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
    Effect.catchTag("ContestRevisionConflict", (cause) => Effect.fail(new RepoError({ cause })))
  )
})
