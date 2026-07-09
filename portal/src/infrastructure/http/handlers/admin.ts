import { HttpApiBuilder } from "@effect/platform"
import { Effect } from "effect"
import { api, InvalidContestTransition, NotFound } from "shared"
import { finishContestUsecase, startContestUsecase } from "../../../application/usecases/contest.js"

export const AdminLive = HttpApiBuilder.group(api, "admin", (handlers) =>
  handlers
    .handle("startContest", () =>
      startContestUsecase.pipe(
        Effect.catchTags({
          ContestNotFound: () => Effect.fail(new NotFound()),
          InvalidContestTransition: (e) => Effect.fail(new InvalidContestTransition({ from: e.from, to: e.to }))
        }),
        Effect.orDie
      )
    )
    .handle("finishContest", () =>
      finishContestUsecase.pipe(
        Effect.catchTags({
          ContestNotFound: () => Effect.fail(new NotFound()),
          InvalidContestTransition: (e) => Effect.fail(new InvalidContestTransition({ from: e.from, to: e.to }))
        }),
        Effect.orDie
      )
    )
)
