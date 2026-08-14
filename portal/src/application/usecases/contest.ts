import { Clock, Effect, Either, Option } from "effect"
import { beginFinalization, finishContest, startContest } from "../../domain/contest.js"
import { ContestNotFound } from "../errors.js"
import { ContestRepo } from "../ports.js"

// GET /api/contest: 未作成(getCurrent = None)は ContestNotFound(404)。
export const getCurrentContest = ContestRepo.pipe(
  Effect.flatMap((repo) => repo.getCurrent),
  Effect.flatMap(Option.match({ onNone: () => Effect.fail(new ContestNotFound()), onSome: Effect.succeed }))
)

// POST /api/admin/contest/start: 不正遷移(preparing 以外からの start)は domain
// の startContest が InvalidContestTransition を返す(409 にマップ)。
// Task 1: startContest は now (epoch ms) を要求し startedAt を刻む。Clock で取得。
export const startContestUsecase = Effect.gen(function* () {
  const repo = yield* ContestRepo
  const contest = yield* repo.getCurrent.pipe(
    Effect.flatMap(Option.match({ onNone: () => Effect.fail(new ContestNotFound()), onSome: Effect.succeed }))
  )
  const now = yield* Clock.currentTimeMillis
  const started = yield* Either.match(startContest(contest, now), { onLeft: Effect.fail, onRight: Effect.succeed })
  yield* repo.save(started)
  return started
})

// POST /api/admin/contest/finish: Task 1 の互換ブリッジ層。
// running -> finalizing (beginFinalization) -> finished (finishContest) を 1 save で
// つなぐ。Task 11 で durable な finalization Operation(scoreboard 確定 → archive
// 保存 → finish_contest step)に置き換えられ、このブリッジは削除される。
export const finishContestUsecase = Effect.gen(function* () {
  const repo = yield* ContestRepo
  const contest = yield* repo.getCurrent.pipe(
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
  yield* repo.save(finished)
  return finished
})
