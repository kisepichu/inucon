import { HttpApiBuilder } from "@effect/platform"
import { Effect } from "effect"
import { api } from "shared"
import { getScoreboard } from "../../../application/usecases/scoreboard.js"

export const ScoreboardLive = HttpApiBuilder.group(api, "scoreboard", (handlers) =>
  handlers.handle("getScoreboard", () => getScoreboard.pipe(Effect.orDie))
)
