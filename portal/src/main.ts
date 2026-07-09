import { createServer } from "node:http"
import { HttpApiBuilder, HttpMiddleware } from "@effect/platform"
import { NodeHttpClient, NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import { api } from "shared"
import { AuthConfig } from "./application/ports.js"
import { GithubOAuthLive } from "./infrastructure/github/oauth.js"
import { AuthLive } from "./infrastructure/http/handlers/auth.js"
import { HealthLive } from "./infrastructure/http/handlers/health.js"
import { AuthenticationLive } from "./infrastructure/http/middleware.js"
import { MigratorLive, SqlLive } from "./infrastructure/sql/client.js"
import { SessionRepoLive } from "./infrastructure/sql/repos/sessionRepo.js"
import { TeamRepoLive } from "./infrastructure/sql/repos/teamRepo.js"
import { UserRepoLive } from "./infrastructure/sql/repos/userRepo.js"
import { UuidGenLive } from "./infrastructure/sql/uuid.js"

// ADMIN_GITHUB_LOGINS(カンマ区切り)に載っている githubLogin はログイン時に
// isAdmin=true になる(スペック §認証)。
const AuthConfigLive = Layer.effect(
  AuthConfig,
  Effect.gen(function* () {
    const raw = yield* Config.string("ADMIN_GITHUB_LOGINS").pipe(Config.withDefault(""))
    return {
      adminGithubLogins: raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "")
    }
  })
)

// UserRepoLive は UuidGen に依存する。provideMerge で 1 インスタンスの
// UuidGenLive を依存解決と公開の両方に使う(repos.test.ts と同じ理由)。
const ReposLive = Layer.mergeAll(UserRepoLive, SessionRepoLive, TeamRepoLive).pipe(
  Layer.provideMerge(UuidGenLive),
  Layer.provide(SqlLive)
)

const ApiLive = HttpApiBuilder.api(api).pipe(
  Layer.provide(Layer.mergeAll(HealthLive, AuthLive)),
  Layer.provide(AuthenticationLive),
  Layer.provide(GithubOAuthLive.pipe(Layer.provide(NodeHttpClient.layer))),
  Layer.provide(AuthConfigLive),
  Layer.provide(ReposLive)
)

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
