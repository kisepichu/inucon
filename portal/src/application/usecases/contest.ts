import { Effect, Either, Option } from "effect"
import { finishContest, startContest } from "../../domain/contest.js"
import { ContestNotFound } from "../errors.js"
import { ContestRepo } from "../ports.js"

// GET /api/contest: 未作成(getCurrent = None)は ContestNotFound(404)。
export const getCurrentContest = ContestRepo.pipe(
  Effect.flatMap((repo) => repo.getCurrent),
  Effect.flatMap(Option.match({ onNone: () => Effect.fail(new ContestNotFound()), onSome: Effect.succeed }))
)

// POST /api/admin/contest/start: 不正遷移(preparing 以外からの start)は domain
// の startContest が InvalidContestTransition を返す(409 にマップ)。
export const startContestUsecase = Effect.gen(function* () {
  const repo = yield* ContestRepo
  const contest = yield* repo.getCurrent.pipe(
    Effect.flatMap(Option.match({ onNone: () => Effect.fail(new ContestNotFound()), onSome: Effect.succeed }))
  )
  const started = yield* Either.match(startContest(contest), { onLeft: Effect.fail, onRight: Effect.succeed })
  yield* repo.save(started)
  return started
})

// POST /api/admin/contest/finish: 不正遷移(running 以外からの finish)は domain
// の finishContest が InvalidContestTransition を返す(409 にマップ)。
export const finishContestUsecase = Effect.gen(function* () {
  const repo = yield* ContestRepo
  const contest = yield* repo.getCurrent.pipe(
    Effect.flatMap(Option.match({ onNone: () => Effect.fail(new ContestNotFound()), onSome: Effect.succeed }))
  )
  const finished = yield* Either.match(finishContest(contest), { onLeft: Effect.fail, onRight: Effect.succeed })
  yield* repo.save(finished)
  return finished
})
