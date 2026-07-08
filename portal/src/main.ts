import { createServer } from "node:http"
import { HttpApiBuilder, HttpMiddleware } from "@effect/platform"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"
import { api } from "shared"
import { HealthLive } from "./infrastructure/http/handlers/health.js"
import { MigratorLive } from "./infrastructure/sql/client.js"

const ApiLive = HttpApiBuilder.api(api).pipe(Layer.provide(HealthLive))

const HttpLive = HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
  Layer.provide(ApiLive),
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

const MainLive = Layer.mergeAll(HttpLive, MigratorLive)

Layer.launch(MainLive).pipe(NodeRuntime.runMain)
