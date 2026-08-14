import { Effect, Option } from "effect"
import type { ContestId } from "../../domain/ids.js"
import { BenchJobRepo, ContestRepo } from "../ports.js"

// GET /api/scoreboard(公開): 現在の表示対象 contest を解決して集計を返す。
// 0 contest 状態は空配列を返して「開催履歴はまだありません」表示に委ねる
// (Task 4 で /api/contests + /api/contests/:id/scoreboard が導入されたら
// この compat handler は将来 archive selector 経由の呼び出しに置き換わる)。
export const getScoreboard = Effect.gen(function* () {
  const contests = yield* ContestRepo
  const contest = yield* contests.getDisplay
  if (Option.isNone(contest)) return []
  const jobs = yield* BenchJobRepo
  return yield* jobs.scoreboard(contest.value.id)
})

// GET /api/contests/:contestId/scoreboard(Task 4)。
export const getScoreboardOf = (contestId: ContestId) =>
  BenchJobRepo.pipe(Effect.flatMap((repo) => repo.scoreboard(contestId)))
