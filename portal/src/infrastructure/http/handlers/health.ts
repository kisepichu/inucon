import { HttpApiBuilder } from "@effect/platform"
import { Effect } from "effect"
import { api } from "shared"

export const HealthLive = HttpApiBuilder.group(api, "health", (handlers) =>
  handlers.handle("getHealth", () => Effect.succeed({ status: "ok" as const }))
)
