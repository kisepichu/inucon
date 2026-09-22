import { HttpApiBuilder } from "@effect/platform"
import { Effect } from "effect"
import { api, NotFound } from "shared"
import {
  getCurrentContest,
  getPublicContestById,
  listPublicContests
} from "../../../application/usecases/contest.js"
import { getScoreboardOf } from "../../../application/usecases/scoreboard.js"

// GET /api/contest(compat): getDisplay 経由の単一 contest。0 contest は 404。
export const ContestLive = HttpApiBuilder.group(api, "contest", (handlers) =>
  handlers.handle("getContest", () =>
    getCurrentContest.pipe(
      Effect.catchTag("ContestNotFound", () => Effect.fail(new NotFound())),
      Effect.orDie
    )
  )
)

// Task 4: 公開 archive API。/api/contests(list)、/api/contests/:id(detail)、
// /api/contests/:id/scoreboard を 1 group にまとめる。canceled は list/detail/
// scoreboard すべてで 404(監査は admin 経路)。
export const ContestsLive = HttpApiBuilder.group(api, "contests", (handlers) =>
  handlers
    .handle("listContests", () => listPublicContests.pipe(Effect.orDie))
    .handle("getContestById", ({ path }) =>
      getPublicContestById(path.contestId).pipe(
        Effect.catchTag("ContestNotFound", () => Effect.fail(new NotFound())),
        Effect.orDie
      )
    )
    .handle("getContestScoreboard", ({ path }) =>
      getScoreboardOf(path.contestId).pipe(
        Effect.catchTag("ContestNotFound", () => Effect.fail(new NotFound())),
        Effect.orDie
      )
    )
)
