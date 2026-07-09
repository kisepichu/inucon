import { HttpApiClient } from "@effect/platform"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import { api } from "shared"
import { makeAppTestLayer } from "../support/testApi.js"

const TestLayer = makeAppTestLayer()

it.effect("GET /api/health は { status: \"ok\" } を返す", () =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(api)
    const result = yield* client.health.getHealth()
    expect(result).toEqual({ status: "ok" })
  }).pipe(Effect.provide(TestLayer))
)
