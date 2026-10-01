import { HttpApiBuilder } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import type { ConfigProvider } from "effect"
import { ConfigProvider as CP, Layer } from "effect"
import { api } from "shared"
import { AuthConfig, OperationWorkerConfig, ProvisioningConfig, RunnerConfig } from "../../src/application/ports.js"
import { AdminLive } from "../../src/infrastructure/http/handlers/admin.js"
import { AuthLive } from "../../src/infrastructure/http/handlers/auth.js"
import { BenchLive } from "../../src/infrastructure/http/handlers/bench.js"
import { ContestLive, ContestsLive } from "../../src/infrastructure/http/handlers/contest.js"
import { ContestAdminLive } from "../../src/infrastructure/http/handlers/contestAdmin.js"
import { HealthLive } from "../../src/infrastructure/http/handlers/health.js"
import { InstancesLive } from "../../src/infrastructure/http/handlers/instances.js"
import { OperationsLive } from "../../src/infrastructure/http/handlers/operations.js"
import { RunnerLive } from "../../src/infrastructure/http/handlers/runner.js"
import { ScoreboardLive } from "../../src/infrastructure/http/handlers/scoreboard.js"
import { TeamsLive } from "../../src/infrastructure/http/handlers/teams.js"
import { AdminOnlyLive, AuthenticationLive, RunnerAuthLive } from "../../src/infrastructure/http/middleware.js"
import { ArtifactsLive } from "../../src/infrastructure/http/handlers/artifacts.js"
import { ArtifactRepoLive } from "../../src/infrastructure/sql/repos/artifactRepo.js"
import { BenchJobRepoLive } from "../../src/infrastructure/sql/repos/benchJobRepo.js"
import { ContestRepoLive } from "../../src/infrastructure/sql/repos/contestRepo.js"
import { InstanceRepoLive } from "../../src/infrastructure/sql/repos/instanceRepo.js"
import { InviteRepoLive } from "../../src/infrastructure/sql/repos/inviteRepo.js"
import { OperationRepoLive } from "../../src/infrastructure/sql/repos/operationRepo.js"
import { ResourceBindingRepoLive } from "../../src/infrastructure/sql/repos/resourceBindingRepo.js"
import { RunnerAgentRepoLive } from "../../src/infrastructure/sql/repos/runnerAgentRepo.js"
import { SessionRepoLive } from "../../src/infrastructure/sql/repos/sessionRepo.js"
import { TeamRepoLive } from "../../src/infrastructure/sql/repos/teamRepo.js"
import { UserRepoLive } from "../../src/infrastructure/sql/repos/userRepo.js"
import { UuidGenLive } from "../../src/infrastructure/sql/uuid.js"
import { TransactionRunnerLive } from "../../src/infrastructure/sql/transactionRunner.js"
import type { StubGithubUser } from "./githubOAuthStub.js"
import { makeGithubOAuthStub } from "./githubOAuthStub.js"
import type { CloudflareInventorySeed, InfrastructureInventorySeed, ManagedVmSeed, ProxmoxTestOptions } from "./inMemory.js"
import {
  makeBackupPortTest,
  makeCloudflarePortTest,
  makeGithubKeysPortTest,
  makeProxmoxPortTest,
  ProvisioningConfigTest
} from "./inMemory.js"
import { MigratorTest, SqlTest } from "./sqlTest.js"

// `:memory:` SQLite + 本番マイグレーション + 本番リポジトリ実装。
// UserRepoLive は UuidGen に依存するため provideMerge で 1 インスタンスに
// 集約する(repos.test.ts と同じ理由)。
// OperationRepoLive は OperationWorkerConfig を要求するため、テスト用固定値を
// provide する(main.ts の OperationWorkerConfigLive と同型 — テストでは
// tick/retry は動かさないが Layer 構築が必要なので任意の正の値でよい)。
const OperationWorkerConfigTestLive = Layer.succeed(OperationWorkerConfig, {
  pollIntervalMillis: 1_000,
  retryBaseMillis: 1_000,
  retryMaxMillis: 30_000,
  maxAttempts: 5,
  leaseDurationMillis: 60_000
})

export const ReposTestLive = Layer.mergeAll(
  UserRepoLive,
  SessionRepoLive,
  TeamRepoLive,
  ContestRepoLive,
  InstanceRepoLive,
  BenchJobRepoLive,
  InviteRepoLive,
  OperationRepoLive,
  ResourceBindingRepoLive,
  ArtifactRepoLive,
  RunnerAgentRepoLive,
  TransactionRunnerLive
).pipe(
  Layer.provideMerge(UuidGenLive),
  Layer.provideMerge(OperationWorkerConfigTestLive),
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

const RunnerConfigTestLive = Layer.succeed(RunnerConfig, {
  jobTimeoutMillis: 600_000,
  // Task 10: runner heartbeat の readiness / gate 判定用。テストは実時間で
  // 走るので十分に長い既定 (60s) を渡し、個別テストは runner_agents を
  // 直接 seed / touch して stale / fresh を切り替える。
  maxAgeMillis: 60_000
})

// Proxmox/Cloudflare/GithubKeys の 3 port(Task 5): AdminLive の inviteMember/
// listInvites ハンドラ(invites.ts 経由)がこれらを要求するため、テスト用
// ApiLive にも配線する(本番 main.ts の InstancePortsLive と同じ理由。未配線
// だと R が unknown のまま漏れ、auth/bench/... 等 invites と無関係な http
// テストまで TS2322 で連鎖的に壊れる)。招待の Access/鍵同期を深く検証する
// テストは application 層(test/application/invites.test.ts)が
// makeProxmoxPortTest 等を直接使うので、ここでは http テスト全般が壊れない
// ための既定のインメモリ実装を提供するだけでよい。githubKeysByLogin だけ
// オプションで個別テストから上書きできるようにする。

import type { CloudflareOperation } from "./inMemory.js"
import type { CloudflareError } from "../../src/application/ports.js"

const makeInstancePortsTestLive = (options: {
  readonly githubKeysByLogin?: Record<string, ReadonlyArray<string>>
  readonly cloudflareInventory?: CloudflareInventorySeed
  readonly proxmoxManagedVms?: ReadonlyArray<ManagedVmSeed>
  readonly proxmoxInfrastructureInventory?: InfrastructureInventorySeed
  readonly proxmoxFailWith?: ProxmoxTestOptions["failWith"]
  readonly cloudflareFailWith?: Partial<Record<CloudflareOperation, CloudflareError>>
}) =>
  Layer.mergeAll(
    makeProxmoxPortTest({
      managedVms: options.proxmoxManagedVms,
      infrastructureInventory: options.proxmoxInfrastructureInventory,
      failWith: options.proxmoxFailWith
    }).layer,
    makeCloudflarePortTest({ inventory: options.cloudflareInventory, failWith: options.cloudflareFailWith }).layer,
    makeGithubKeysPortTest(options.githubKeysByLogin ?? {})
  )

// 本物の api(shared)を GithubOAuthPort だけスタブして起動するテスト Layer。
// テスト本体からは repos(login ヘルパー等)と HttpClient(layerTest)が見える。
export const makeAppTestLayer = (options?: {
  readonly stubCodes?: Record<string, StubGithubUser>
  readonly adminGithubLogins?: ReadonlyArray<string>
  // COOKIE_SECURE 等の Config を読むテスト(空文字検証、Secure 属性の切替)用に
  // ConfigProvider を差し替え可能にする。未指定時は既定(process.env + RUNNER_TOKEN)のまま。
  readonly configProvider?: ConfigProvider.ConfigProvider
  // 招待の鍵注入を検証するテスト用に GithubKeysPort のスタブ対応表を上書きできる。
  readonly githubKeysByLogin?: Record<string, ReadonlyArray<string>>
  // Task 7: reconciliation の inventory を直接シードするテスト用。plan は
  // Proxmox / Cloudflare の inventory から生成されるため、http テストは
  // これで観測結果を制御する(ambiguous / stale / adopt の分岐検証)。
  readonly cloudflareInventory?: CloudflareInventorySeed
  readonly proxmoxManagedVms?: ReadonlyArray<ManagedVmSeed>
  // Task 7 review round 3 #1: provider 呼び出しを強制失敗させる(503 マッピング検証)。
  readonly cloudflareFailWith?: Partial<Record<CloudflareOperation, CloudflareError>>
  // prepare-instances の競技モード前提 (devvm / benchvm の観測) と、inventory
  // 取得失敗の 503 マッピングを検証するテスト用。未指定なら normal mode の既定値。
  readonly proxmoxInfrastructureInventory?: InfrastructureInventorySeed
  readonly proxmoxFailWith?: ProxmoxTestOptions["failWith"]
}) =>
  HttpApiBuilder.serve().pipe(
    Layer.provideMerge(
      HttpApiBuilder.api(api).pipe(
        Layer.provide(
          Layer.mergeAll(
            HealthLive,
            AuthLive,
            ContestLive,
            ContestsLive,
            TeamsLive,
            InstancesLive,
            AdminLive,
            ContestAdminLive,
            BenchLive,
            RunnerLive,
            ScoreboardLive,
            OperationsLive,
            ArtifactsLive
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
        Layer.provide(makeInstancePortsTestLive(options ?? {})),
        // createTeamInstance(自チーム追加ボタン)ハンドラが RAM ガード閾値を
        // 要求するため、http テスト全般が壊れないよう既定値を配線する
        // (makeInstancePortsTestLive と同じ理由)。
        Layer.provide(ProvisioningConfigTest()),
        // Task 10: readiness (operations handler) が BackupPort を要求する。
        // http テストは実 FS canary を触らないので probe=success で埋める
        // (dedicated backup probe テストは test/infrastructure/backupProbe.test.ts)。
        Layer.provide(makeBackupPortTest()),
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
