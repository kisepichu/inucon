import { HttpApiBuilder } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import type { ConfigProvider } from "effect"
import { Layer } from "effect"
import { api } from "shared"
import { AuthConfig } from "../../src/application/ports.js"
import { AdminLive } from "../../src/infrastructure/http/handlers/admin.js"
import { AuthLive } from "../../src/infrastructure/http/handlers/auth.js"
import { ContestLive } from "../../src/infrastructure/http/handlers/contest.js"
import { HealthLive } from "../../src/infrastructure/http/handlers/health.js"
import { InstancesLive } from "../../src/infrastructure/http/handlers/instances.js"
import { TeamsLive } from "../../src/infrastructure/http/handlers/teams.js"
import { AdminOnlyLive, AuthenticationLive } from "../../src/infrastructure/http/middleware.js"
import { ContestRepoLive } from "../../src/infrastructure/sql/repos/contestRepo.js"
import { InstanceRepoLive } from "../../src/infrastructure/sql/repos/instanceRepo.js"
import { SessionRepoLive } from "../../src/infrastructure/sql/repos/sessionRepo.js"
import { TeamRepoLive } from "../../src/infrastructure/sql/repos/teamRepo.js"
import { UserRepoLive } from "../../src/infrastructure/sql/repos/userRepo.js"
import { UuidGenLive } from "../../src/infrastructure/sql/uuid.js"
import type { StubGithubUser } from "./githubOAuthStub.js"
import { makeGithubOAuthStub } from "./githubOAuthStub.js"
import { MigratorTest, SqlTest } from "./sqlTest.js"

// `:memory:` SQLite + 本番マイグレーション + 本番リポジトリ実装。
// UserRepoLive は UuidGen に依存するため provideMerge で 1 インスタンスに
// 集約する(repos.test.ts と同じ理由)。
export const ReposTestLive = Layer.mergeAll(
  UserRepoLive,
  SessionRepoLive,
  TeamRepoLive,
  ContestRepoLive,
  InstanceRepoLive
).pipe(
  Layer.provideMerge(UuidGenLive),
  Layer.provideMerge(MigratorTest),
  Layer.provideMerge(SqlTest)
)

// 本物の api(shared)を GithubOAuthPort だけスタブして起動するテスト Layer。
// テスト本体からは repos(login ヘルパー等)と HttpClient(layerTest)が見える。
export const makeAppTestLayer = (options?: {
  readonly stubCodes?: Record<string, StubGithubUser>
  readonly adminGithubLogins?: ReadonlyArray<string>
  // COOKIE_SECURE 等の Config を読むテスト(空文字検証、Secure 属性の切替)用に
  // ConfigProvider を差し替え可能にする。未指定時は既定(process.env)のまま。
  readonly configProvider?: ConfigProvider.ConfigProvider
}) =>
  HttpApiBuilder.serve().pipe(
    Layer.provideMerge(
      HttpApiBuilder.api(api).pipe(
        Layer.provide(Layer.mergeAll(HealthLive, AuthLive, ContestLive, TeamsLive, InstancesLive, AdminLive)),
        Layer.provide(AuthenticationLive),
        Layer.provide(AdminOnlyLive),
        Layer.provide(makeGithubOAuthStub(options?.stubCodes ?? {})),
        Layer.provide(
          Layer.succeed(AuthConfig, { adminGithubLogins: options?.adminGithubLogins ?? [] })
        ),
        Layer.provide(
          options?.configProvider !== undefined ? Layer.setConfigProvider(options.configProvider) : Layer.empty
        )
      )
    ),
    Layer.provideMerge(ReposTestLive),
    Layer.provideMerge(NodeHttpServer.layerTest)
  )
