import { HttpApiBuilder, HttpApiClient } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { expect } from "vitest"
import { api } from "shared"
import { HealthLive } from "../../src/infrastructure/http/handlers/health.js"
import { MigratorTest } from "../support/sqlTest.js"

const ApiLive = HttpApiBuilder.api(api).pipe(Layer.provide(HealthLive))

const HttpServerLive = HttpApiBuilder.serve().pipe(Layer.provide(ApiLive))

// provideMerge でサーバーへの提供とテスト側への公開(HttpApiClient が使う
// HttpClient)を NodeHttpServer.layerTest 一箇所に集約する。
const TestLayer = Layer.mergeAll(HttpServerLive, MigratorTest).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest)
)

it.effect("GET /api/health は { status: \"ok\" } を返す", () =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(api)
    const result = yield* client.health.getHealth()
    expect(result).toEqual({ status: "ok" })
  }).pipe(Effect.provide(TestLayer))
)
