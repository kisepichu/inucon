import { HttpApiBuilder } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import type { ConfigProvider } from "effect"
import { Clock, ConfigProvider as CP, Layer } from "effect"
import { api } from "shared"
import { AuthConfig, RunnerConfig } from "../../src/application/ports.js"
import { AdminLive } from "../../src/infrastructure/http/handlers/admin.js"
import { AuthLive } from "../../src/infrastructure/http/handlers/auth.js"
import { BenchLive } from "../../src/infrastructure/http/handlers/bench.js"
import { ContestLive } from "../../src/infrastructure/http/handlers/contest.js"
import { HealthLive } from "../../src/infrastructure/http/handlers/health.js"
import { InstancesLive } from "../../src/infrastructure/http/handlers/instances.js"
import { RunnerLive } from "../../src/infrastructure/http/handlers/runner.js"
import { ScoreboardLive } from "../../src/infrastructure/http/handlers/scoreboard.js"
import { TeamsLive } from "../../src/infrastructure/http/handlers/teams.js"
import { AdminOnlyLive, AuthenticationLive, RunnerAuthLive } from "../../src/infrastructure/http/middleware.js"
import { BenchJobRepoLive } from "../../src/infrastructure/sql/repos/benchJobRepo.js"
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
  InstanceRepoLive,
  BenchJobRepoLive
).pipe(
  Layer.provideMerge(UuidGenLive),
  Layer.provideMerge(MigratorTest),
  Layer.provideMerge(SqlTest)
)

// テスト用の固定 RUNNER_TOKEN。RunnerAuthLive はビルド時に Config.redacted で
// これを読む(middleware.ts)。makeAppTestLayer の configProvider オプション
// (COOKIE_SECURE 等の上書き用)は特定キーだけの Map で全体を置き換えるため、
// RUNNER_TOKEN が消えて RunnerAuthLive のビルドが落ちないよう
// ConfigProvider.orElse でこの既定値にフォールバックさせる(個別レイヤーへの
// setConfigProvider の入れ子は Layer グラフ内で同じ FiberRef を共有する兄弟
// レイヤーに漏れて COOKIE_SECURE 等の判定を壊すため避ける)。
export const RUNNER_TOKEN_TEST = "test-runner-token"

const baseTestConfigProvider = CP.fromMap(new Map([["RUNNER_TOKEN", RUNNER_TOKEN_TEST]])).pipe(
  CP.orElse(() => CP.fromEnv())
)

const RunnerConfigTestLive = Layer.succeed(RunnerConfig, { jobTimeoutMillis: 600_000 })

// 本物の api(shared)を GithubOAuthPort だけスタブして起動するテスト Layer。
// テスト本体からは repos(login ヘルパー等)と HttpClient(layerTest)が見える。
export const makeAppTestLayer = (options?: {
  readonly stubCodes?: Record<string, StubGithubUser>
  readonly adminGithubLogins?: ReadonlyArray<string>
  // COOKIE_SECURE 等の Config を読むテスト(空文字検証、Secure 属性の切替)用に
  // ConfigProvider を差し替え可能にする。未指定時は既定(process.env + RUNNER_TOKEN)のまま。
  readonly configProvider?: ConfigProvider.ConfigProvider
}) =>
  HttpApiBuilder.serve().pipe(
    Layer.provideMerge(
      HttpApiBuilder.api(api).pipe(
        Layer.provide(
          Layer.mergeAll(
            HealthLive,
            AuthLive,
            ContestLive,
            TeamsLive,
            InstancesLive,
            AdminLive,
            BenchLive,
            RunnerLive,
            ScoreboardLive
          )
        ),
        Layer.provide(AuthenticationLive),
        Layer.provide(AdminOnlyLive),
        Layer.provide(RunnerAuthLive),
        Layer.provide(RunnerConfigTestLive),
        Layer.provide(makeGithubOAuthStub(options?.stubCodes ?? {})),
        Layer.provide(
          Layer.succeed(AuthConfig, { adminGithubLogins: options?.adminGithubLogins ?? [] })
        ),
        Layer.provide(
          Layer.setConfigProvider(
            options?.configProvider !== undefined
              ? options.configProvider.pipe(CP.orElse(() => baseTestConfigProvider))
              : baseTestConfigProvider
          )
        )
      )
    ),
    Layer.provideMerge(ReposTestLive),
    Layer.provideMerge(NodeHttpServer.layerTest)
  )
