import { HttpApiBuilder } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { Layer } from "effect"
import { api } from "shared"
import { AuthConfig } from "../../src/application/ports.js"
import { AuthLive } from "../../src/infrastructure/http/handlers/auth.js"
import { HealthLive } from "../../src/infrastructure/http/handlers/health.js"
import { AuthenticationLive } from "../../src/infrastructure/http/middleware.js"
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
export const ReposTestLive = Layer.mergeAll(UserRepoLive, SessionRepoLive, TeamRepoLive).pipe(
  Layer.provideMerge(UuidGenLive),
  Layer.provideMerge(MigratorTest),
  Layer.provideMerge(SqlTest)
)

// 本物の api(shared)を GithubOAuthPort だけスタブして起動するテスト Layer。
// テスト本体からは repos(login ヘルパー等)と HttpClient(layerTest)が見える。
export const makeAppTestLayer = (options?: {
  readonly stubCodes?: Record<string, StubGithubUser>
  readonly adminGithubLogins?: ReadonlyArray<string>
}) =>
  HttpApiBuilder.serve().pipe(
    Layer.provideMerge(
      HttpApiBuilder.api(api).pipe(
        Layer.provide(Layer.mergeAll(HealthLive, AuthLive)),
        Layer.provide(AuthenticationLive),
        Layer.provide(makeGithubOAuthStub(options?.stubCodes ?? {})),
        Layer.provide(
          Layer.succeed(AuthConfig, { adminGithubLogins: options?.adminGithubLogins ?? [] })
        )
      )
    ),
    Layer.provideMerge(ReposTestLive),
    Layer.provideMerge(NodeHttpServer.layerTest)
  )
