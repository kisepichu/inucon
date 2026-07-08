import { HttpApiBuilder, HttpApiClient } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { expect } from "vitest"
import { api } from "shared"
import { HealthLive } from "../../src/infrastructure/http/handlers/health.js"
import { MigratorTest } from "../support/sqlTest.js"

const ApiLive = HttpApiBuilder.api(api).pipe(Layer.provide(HealthLive))

const HttpServerLive = HttpApiBuilder.serve().pipe(
  Layer.provide(ApiLive),
  Layer.provide(NodeHttpServer.layerTest)
)

// HttpServerLive はサーバーを起動するだけで自身は何も公開しないため、
// テストで使う HttpClient を得るために NodeHttpServer.layerTest を明示的に併記する。
const TestLayer = Layer.mergeAll(HttpServerLive, MigratorTest, NodeHttpServer.layerTest)

it.effect("GET /api/health は { status: \"ok\" } を返す", () =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(api)
    const result = yield* client.health.getHealth()
    expect(result).toEqual({ status: "ok" })
  }).pipe(Effect.provide(TestLayer))
)
