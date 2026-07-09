import { HttpApiBuilder } from "@effect/platform"
import { Effect } from "effect"
import { api, NotFound } from "shared"
import { getCurrentContest } from "../../../application/usecases/contest.js"

export const ContestLive = HttpApiBuilder.group(api, "contest", (handlers) =>
  handlers.handle("getContest", () =>
    getCurrentContest.pipe(
      Effect.catchTag("ContestNotFound", () => Effect.fail(new NotFound())),
      Effect.orDie
    )
  )
)
