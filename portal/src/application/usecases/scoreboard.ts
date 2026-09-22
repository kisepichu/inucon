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
//
// TOCTOU note (review claude iter 2): findById(canceled 判定) と
// jobs.scoreboard(contestId) は別クエリのため、間で admin が cancel すると
// 抽象的には「canceled 済 contest のスコアを 200 で返す」window が開く。
// ただし cancel は draft|preparing のみから遷移可能で (plan Global Constraints)、
// preparing の contest は checkEnqueueAllowed により rehearsal しか enqueue
// できず、BenchJobRepo.scoreboard は purpose='competition' filter のため、
// cancel 可能な状態の scoreboard は常に「0 チーム 0 スコア」(空 array) にしか
// ならない。つまり漏洩する情報は無い。加えて公開クライアントは 10 秒 poll で
// 再取得するので次の tick で自然に 404 に収束する。以上より extra findById で
// window を狭める必要は無いと判定し、シングル findById + scoreboard のままにする。
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
