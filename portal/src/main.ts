import { createServer } from "node:http"
import { HttpApiBuilder, HttpMiddleware } from "@effect/platform"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import { api } from "shared"
import { HealthLive } from "./infrastructure/http/handlers/health.js"
import { MigratorLive } from "./infrastructure/sql/client.js"

const ApiLive = HttpApiBuilder.api(api).pipe(Layer.provide(HealthLive))

const ServerLive = Layer.unwrapEffect(
  Effect.map(Config.integer("PORT").pipe(Config.withDefault(3000)), (port) =>
    NodeHttpServer.layer(createServer, { port })
  )
)

const HttpLive = HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
  Layer.provide(ApiLive),
  Layer.provide(ServerLive)
)

const MainLive = Layer.mergeAll(HttpLive, MigratorLive)

Layer.launch(MainLive).pipe(NodeRuntime.runMain)
