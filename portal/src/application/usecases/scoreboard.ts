import { Effect } from "effect"
import { BenchJobRepo } from "../ports.js"

// GET /api/scoreboard: BenchJobRepo.scoreboard(Task 4 で集計ロジックを実装
// 済み。finished ジョブのみ集計、latest は finished_at 最大 タイは id 降順、
// best は MAX(score)、0 件チームも必ず返る)をそのまま返す。ユースケース層は
// 素通しでよい。
export const getScoreboard = BenchJobRepo.pipe(Effect.flatMap((repo) => repo.scoreboard))
