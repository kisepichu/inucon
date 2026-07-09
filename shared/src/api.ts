import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { Schema } from "effect"

export const healthGroup = HttpApiGroup.make("health").add(
  HttpApiEndpoint.get("getHealth", "/api/health").addSuccess(
    Schema.Struct({ status: Schema.Literal("ok") })
  )
)

export const api = HttpApi.make("inucon").add(healthGroup)
