import { Effect, Option } from "effect"
import type { ContestId } from "../../domain/ids.js"
import { ContestNotFound } from "../errors.js"
import { BenchJobRepo, ContestRepo } from "../ports.js"

// GET /api/scoreboard(公開): 現在の表示対象 contest を解決して集計を返す。
// 0 contest 状態は空配列を返して「開催履歴はまだありません」表示に委ねる
// (Task 4 で /api/contests + /api/contests/:id/scoreboard を追加したので、
// 明示 ID 経路は getScoreboardOf を使う)。
export const getScoreboard = Effect.gen(function* () {
  const contests = yield* ContestRepo
  const contest = yield* contests.getDisplay
  if (Option.isNone(contest)) return []
  const jobs = yield* BenchJobRepo
  return yield* jobs.scoreboard(contest.value.id)
})

// GET /api/contests/:contestId/scoreboard(Task 4)。ID 明示。canceled/未存在は
// 404(getPublicContestById と同じ扱い)。
export const getScoreboardOf = (contestId: ContestId) =>
  Effect.gen(function* () {
    const contests = yield* ContestRepo
    const contest = yield* contests.findById(contestId)
    if (Option.isNone(contest) || contest.value.status === "canceled") {
      return yield* Effect.fail(new ContestNotFound())
    }
    const jobs = yield* BenchJobRepo
    return yield* jobs.scoreboard(contestId)
  })
