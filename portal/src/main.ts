import { createServer } from "node:http"
import { HttpApiBuilder, HttpMiddleware } from "@effect/platform"
import { NodeHttpClient, NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import { api } from "shared"
import { AuthConfig, RunnerConfig } from "./application/ports.js"
import { GithubOAuthLive } from "./infrastructure/github/oauth.js"
import { AdminLive } from "./infrastructure/http/handlers/admin.js"
import { AuthLive } from "./infrastructure/http/handlers/auth.js"
import { BenchLive } from "./infrastructure/http/handlers/bench.js"
import { ContestLive } from "./infrastructure/http/handlers/contest.js"
import { HealthLive } from "./infrastructure/http/handlers/health.js"
import { InstancesLive } from "./infrastructure/http/handlers/instances.js"
import { RunnerLive } from "./infrastructure/http/handlers/runner.js"
import { TeamsLive } from "./infrastructure/http/handlers/teams.js"
import { AdminOnlyLive, AuthenticationLive, RunnerAuthLive } from "./infrastructure/http/middleware.js"
import { MigratorLive, SqlLive } from "./infrastructure/sql/client.js"
import { BenchJobRepoLive } from "./infrastructure/sql/repos/benchJobRepo.js"
import { ContestRepoLive } from "./infrastructure/sql/repos/contestRepo.js"
import { InstanceRepoLive } from "./infrastructure/sql/repos/instanceRepo.js"
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
const ReposLive = Layer.mergeAll(
  UserRepoLive,
  SessionRepoLive,
  TeamRepoLive,
  ContestRepoLive,
  InstanceRepoLive,
  BenchJobRepoLive
).pipe(
  Layer.provideMerge(UuidGenLive),
  Layer.provide(SqlLive)
)

// JOB_TIMEOUT_MILLIS: running のハートビート(進捗報告)がこの時間途絶えたら
// failed にする(スペック §BenchJob 不変条件 4)。既定 10 分。
const RunnerConfigLive = Layer.effect(
  RunnerConfig,
  Config.integer("JOB_TIMEOUT_MILLIS").pipe(
    Config.withDefault(600_000),
    Effect.map((jobTimeoutMillis) => ({ jobTimeoutMillis }))
  )
)

const ApiLive = HttpApiBuilder.api(api).pipe(
  Layer.provide(
    Layer.mergeAll(HealthLive, AuthLive, ContestLive, TeamsLive, InstancesLive, AdminLive, BenchLive, RunnerLive)
  ),
  Layer.provide(AuthenticationLive),
  Layer.provide(AdminOnlyLive),
  Layer.provide(RunnerAuthLive),
  Layer.provide(RunnerConfigLive),
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
