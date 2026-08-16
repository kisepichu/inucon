import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { HttpApiBuilder, HttpMiddleware } from "@effect/platform"
import { NodeHttpClient, NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Config, Effect, Layer, Option } from "effect"
import { api } from "shared"
import {
  AuthConfig,
  HostnameConfig,
  OperationHandlerRegistry,
  OperationWorkerConfig,
  ProvisioningConfig,
  RunnerConfig
} from "./application/ports.js"
import {
  DEFAULT_OPERATION_LEASE_DURATION_MILLIS,
  DEFAULT_OPERATION_MAX_ATTEMPTS,
  DEFAULT_OPERATION_POLL_INTERVAL_MILLIS,
  DEFAULT_OPERATION_RETRY_BASE_MILLIS,
  DEFAULT_OPERATION_RETRY_MAX_MILLIS
} from "./application/usecases/operations.js"
import { makeReconciliationHandler } from "./application/usecases/reconciliation.js"
import {
  ENTER_CONTEST_MODE_STEP_KEYS,
  makeEnterContestModeHandler
} from "./application/usecases/modeOperation.js"
import {
  makePrepareHandler,
  PREPARE_STEP_KEY,
  PrepareConfigDefault
} from "./application/usecases/prepare.js"
import {
  BACKUP_STEP_KEYS,
  FINISH_STEP_KEYS,
  makeContestFinalizationHandler
} from "./application/usecases/finalization.js"
import {
  makeStartContestHandler,
  START_CONTEST_STEP_KEY
} from "./application/usecases/startOperation.js"
import { CloudflareLive } from "./infrastructure/cloudflare/client.js"
import { BackupPortLive } from "./infrastructure/backup/sqlite.js"
import { GithubKeysLive } from "./infrastructure/github/keys.js"
import { GithubOAuthLive } from "./infrastructure/github/oauth.js"
import { AdminLive } from "./infrastructure/http/handlers/admin.js"
import { AuthLive } from "./infrastructure/http/handlers/auth.js"
import { BenchLive } from "./infrastructure/http/handlers/bench.js"
import { ArtifactsLive } from "./infrastructure/http/handlers/artifacts.js"
import { ContestLive, ContestsLive } from "./infrastructure/http/handlers/contest.js"
import { ContestAdminLive } from "./infrastructure/http/handlers/contestAdmin.js"
import { HealthLive } from "./infrastructure/http/handlers/health.js"
import { InstancesLive } from "./infrastructure/http/handlers/instances.js"
import { OperationsLive } from "./infrastructure/http/handlers/operations.js"
import { RunnerLive } from "./infrastructure/http/handlers/runner.js"
import { ScoreboardLive } from "./infrastructure/http/handlers/scoreboard.js"
import { TeamsLive } from "./infrastructure/http/handlers/teams.js"
import { AdminOnlyLive, AuthenticationLive, RunnerAuthLive } from "./infrastructure/http/middleware.js"
import { makeStaticMiddleware } from "./infrastructure/http/static.js"
import { ProxmoxHttpClientLive, ProxmoxLive } from "./infrastructure/proxmox/client.js"
import { InstancePortsStubLive } from "./infrastructure/stubPorts.js"
import { MigratorLive, SqlLive } from "./infrastructure/sql/client.js"
import { SeedLive } from "./infrastructure/sql/seed.js"
import { TransactionRunnerLive } from "./infrastructure/sql/transactionRunner.js"
import { BenchJobRepoLive } from "./infrastructure/sql/repos/benchJobRepo.js"
import { ContestRepoLive } from "./infrastructure/sql/repos/contestRepo.js"
import { InstanceRepoLive } from "./infrastructure/sql/repos/instanceRepo.js"
import { InviteRepoLive } from "./infrastructure/sql/repos/inviteRepo.js"
import { SessionRepoLive } from "./infrastructure/sql/repos/sessionRepo.js"
import { TeamRepoLive } from "./infrastructure/sql/repos/teamRepo.js"
import { UserRepoLive } from "./infrastructure/sql/repos/userRepo.js"
import { UuidGenLive } from "./infrastructure/sql/uuid.js"
import { ProvisionerLive } from "./infrastructure/worker/provisioner.js"
import { ArtifactRepoLive } from "./infrastructure/sql/repos/artifactRepo.js"
import { OperationRepoLive } from "./infrastructure/sql/repos/operationRepo.js"
import { ResourceBindingRepoLive } from "./infrastructure/sql/repos/resourceBindingRepo.js"
import { RunnerAgentRepoLive } from "./infrastructure/sql/repos/runnerAgentRepo.js"
import { ContestSchedulerLive } from "./infrastructure/worker/contestScheduler.js"
import { OperationWorkerLive } from "./infrastructure/worker/operationWorker.js"
import { TimeoutSweeperLive } from "./infrastructure/worker/timeoutSweeper.js"

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
// Task 6: Operation ワーカー設定は env で上書き可能。全て正の整数に
// バリデートし、不正値は Layer 構築失敗として早期に気付く(RunnerConfig と同型)。
const OperationWorkerConfigLive = Layer.effect(
  OperationWorkerConfig,
  Effect.gen(function* () {
    const positive = (name: string, defaultValue: number) =>
      Config.integer(name).pipe(
        Config.withDefault(defaultValue),
        Config.validate({
          message: `${name} must be a positive integer`,
          validation: (n) => n > 0
        })
      )
    const pollIntervalMillis = yield* positive(
      "OPERATION_POLL_INTERVAL_MILLIS",
      DEFAULT_OPERATION_POLL_INTERVAL_MILLIS
    )
    const retryBaseMillis = yield* positive(
      "OPERATION_RETRY_BASE_MILLIS",
      DEFAULT_OPERATION_RETRY_BASE_MILLIS
    )
    const retryMaxMillis = yield* positive(
      "OPERATION_RETRY_MAX_MILLIS",
      DEFAULT_OPERATION_RETRY_MAX_MILLIS
    )
    const maxAttempts = yield* positive(
      "OPERATION_MAX_ATTEMPTS",
      DEFAULT_OPERATION_MAX_ATTEMPTS
    )
    const leaseDurationMillis = yield* positive(
      "OPERATION_LEASE_DURATION_MILLIS",
      DEFAULT_OPERATION_LEASE_DURATION_MILLIS
    )
    return { pollIntervalMillis, retryBaseMillis, retryMaxMillis, maxAttempts, leaseDurationMillis }
  })
)

// Task 7 review round 3 #2: reconciliation handler / provisioning が使う
// zone suffix を env に外出しする。既定 "kisen.one"(現行本番と同値、後方互換)。
const HostnameConfigLive = Layer.effect(
  HostnameConfig,
  Config.string("CF_ZONE_NAME").pipe(
    Config.withDefault("kisen.one"),
    Effect.map((zoneName) => ({ zoneName }))
  )
)
const ReposLive = Layer.mergeAll(
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
  Layer.provide(OperationWorkerConfigLive),
  Layer.provide(SqlLive)
)

// RunnerConfig: JOB_TIMEOUT_MILLIS は running のハートビート(進捗報告)が
// この時間途絶えたら failed にする既定 10 分 (spec §BenchJob 不変条件 4)。
// Task 10: RUNNER_MAX_AGE_MILLIS は runner heartbeat の readiness / start gate
// 判定に使う。既定 60_000ms (readiness spec)。両方とも env で上書き可能で、
// 不正値 (<=0) は Layer 構築失敗として早期に気付く。
const RunnerConfigLive = Layer.effect(
  RunnerConfig,
  Effect.all({
    jobTimeoutMillis: Config.integer("JOB_TIMEOUT_MILLIS").pipe(
      Config.withDefault(600_000),
      Config.validate({
        message: "JOB_TIMEOUT_MILLIS must be a positive integer",
        validation: (n) => n > 0
      })
    ),
    maxAgeMillis: Config.integer("RUNNER_MAX_AGE_MILLIS").pipe(
      Config.withDefault(60_000),
      Config.validate({
        message: "RUNNER_MAX_AGE_MILLIS must be a positive integer",
        validation: (n) => n > 0
      })
    )
  })
)

// 払い出しガードの閾値・タイムアウト(Phase 3、Task 4)。既定は spike メモ
// §リスク4 の RAM 閾値 5GiB(= 1 インスタンス 4GiB + 予備 1GiB)と、guest agent
// 待機 120 秒。RunnerConfigLive と同じく Config から組み立て、値は正の整数に
// バリデートする(不正値でも Layer 構築を失敗させて早期に気付ける)。この
// Layer は env 依存が既定値ありのため単体では起動を壊さないが、消費者である
// ProvisionerLive は実 port Live(Proxmox/Cloudflare/Github)を要し、それらは
// env 必須のため MainLive への配線は Task 7 に委ねる(下記 WorkerLive の注記)。
export const ProvisioningConfigLive = Layer.effect(
  ProvisioningConfig,
  Effect.gen(function* () {
    const minFreeMemBytes = yield* Config.integer("PROVISION_MIN_FREE_MEM_BYTES").pipe(
      Config.withDefault(5_000_000_000),
      Config.validate({
        message: "PROVISION_MIN_FREE_MEM_BYTES must be a positive integer",
        validation: (n) => n > 0
      })
    )
    const guestAgentTimeoutMillis = yield* Config.integer("PROVISION_GUEST_AGENT_TIMEOUT_MILLIS").pipe(
      Config.withDefault(120_000),
      Config.validate({
        message: "PROVISION_GUEST_AGENT_TIMEOUT_MILLIS must be a positive integer",
        validation: (n) => n > 0
      })
    )
    return { minFreeMemBytes, guestAgentTimeoutMillis }
  })
)

// Proxmox/Cloudflare/GithubKeys の 3 port(Task 5 レビュー): AdminLive の
// inviteMember ハンドラ(invites.ts 経由)が admin.ts:28 で要求するのと同じ
// 3 port を ApiLive にも配線する必要がある。ProvisionerConditionalLive の
// 実 Layer 一式(下記)と同一の組み立てを 1 つの Layer にまとめ、ApiLive と
// ProvisionerConditionalLive の両方から同じ参照(InstancePortsLive)を
// provide することで、
// - 実装(env 有無での実 Live/スタブの切替)を 1 箇所にする
// - Layer メモ化(同一参照は 1 度だけ構築)により二重構築しない
// を両立する。
//
// env(PROXMOX_API_URL)が無い場合は InstancePortsStubLive(stubPorts.ts)に
// フォールバックする: 各メソッドが「PROXMOX_API_URL 未設定のため
// インスタンス操作は無効」という ProxmoxError/CloudflareError/GithubKeysError
// を返すだけの no-op 実装。これにより招待エンドポイント(POST
// /api/admin/teams/:id/invites)は env 未設定でもポータル割当
// (team_members/team_invites への反映)自体は成功し、Access/鍵注入だけが
// 結果の error フィールドに degrade する(invites.ts の syncRunningInstances
// が Effect.either で拾う設計)。
//
// TLS の HttpClient 分離(Task 3 レビュー指摘、下記 ProvisionerConditionalLive
// の注記と同じ理由): ProxmoxHttpClientLive は ProxmoxLive にだけ provide し、
// Cloudflare/GitHub 向けの通常の NodeHttpClient.layer とは混ぜない。
const InstancePortsLive = Layer.unwrapEffect(
  Config.option(Config.string("PROXMOX_API_URL")).pipe(
    Effect.map((proxmoxApiUrl) =>
      Option.isSome(proxmoxApiUrl)
        ? Layer.mergeAll(
            ProxmoxLive.pipe(Layer.provide(ProxmoxHttpClientLive)),
            CloudflareLive.pipe(Layer.provide(NodeHttpClient.layer)),
            GithubKeysLive.pipe(Layer.provide(NodeHttpClient.layer))
          )
        : InstancePortsStubLive
    )
  )
)

const ApiLive = HttpApiBuilder.api(api).pipe(
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
  Layer.provide(RunnerConfigLive),
  Layer.provide(GithubOAuthLive.pipe(Layer.provide(NodeHttpClient.layer))),
  Layer.provide(AuthConfigLive),
  Layer.provide(InstancePortsLive),
  // createTeamInstance ハンドラ(requestCreateInstance 経由)が RAM ガードの
  // 閾値(ProvisioningConfig)を要求する(Task 4 で実装済みの既定値付き
  // Config、ProvisionerConditionalLive と同一参照でメモ化される)。
  Layer.provide(ProvisioningConfigLive),
  // Task 10: readiness の backup key と Task 11 の snapshot API 用に
  // BackupPortLive を配線する。BACKUP_PATH 未設定の環境 (dev/test 直起動) では
  // probe が not_configured で fail するだけで HTTP サーバー自体は起動する
  // (readiness の 1 key が fail するのみ)。
  Layer.provide(BackupPortLive),
  Layer.provide(ReposLive)
)

const ServerLive = Layer.unwrapEffect(
  Effect.map(Config.integer("PORT").pipe(Config.withDefault(3000)), (port) =>
    NodeHttpServer.layer(createServer, { port })
  )
)

// web/dist(portal/web の Vite ビルド成果物)へのパス。dist/main.js(ビルド後)
// と src/main.ts(tsx watch の開発時)はいずれも portal 直下の 1 階層下にある
// ため、"../web/dist" で両方から同じ portal/web/dist を指せる(static.ts の
// README 兼ねる)。
const webDistPath = fileURLToPath(new URL("../web/dist", import.meta.url))

// 起動時シード(Task 11): 空の DB に対して INUCON コンテストを 1 件投入する。
// ReposLive/MigratorLive は HttpLive・WorkerLive と同一の参照なので、
// Layer のメモ化により SqlClient・Migrator の実行はプロセス全体で 1 回だけ。
const SeedInitLive = SeedLive.pipe(Layer.provide(ReposLive), Layer.provide(MigratorLive))

// Migration 依存: migration 前に最初のリクエストが来ると "no such table"
// になる潜在レース。MigratorLive を依存として挟むことで、HTTP サーバー起動
// 前に migration の完了を待たせる(参照は MainLive の MigratorLive と同一なので
// メモ化により 1 回だけ実行される)。WorkerLive と同じ根本原因。
//
// 静的配信(static.ts): /api・/auth・/docs 以外は web/dist を配信する
// ミドルウェアを HttpApi ルータ(httpApp)の外側に挟む。logger はさらにその
// 外側にすることで、静的ファイル配信も含め全リクエストがログされる。
const HttpLive = HttpApiBuilder.serve((httpApp) =>
  HttpMiddleware.logger(makeStaticMiddleware(webDistPath)(httpApp))
).pipe(
  Layer.provide(ApiLive),
  Layer.provide(ServerLive),
  Layer.provide(MigratorLive),
  // seed 完了前にリクエストを受けると新規 DB でコンテスト 404 になる窓が
  // できるため、HTTP サーバーも seed の完了を待ってから起動する。
  Layer.provide(SeedInitLive)
)

// タイムアウト回収ワーカー(Task 8)。ApiLive と同じ ReposLive/RunnerConfigLive
// の参照を再利用することで、Layer のメモ化(同一 Layer 参照は 1 度だけ構築
// される)により SqlLive の接続を 1 つに共有する(ApiLive 側と別接続を開かない)。
// MigratorLive も明示的に provide する: Layer.scopedDiscard は構築時に即
// fork するため、MigratorLive が MainLive の並列な兄弟のままだと migration
// 未完了のうちに 1 回目の sweep が走り "no such table" で失敗しうる
// (catchAllCause で fiber は死なないが起動直後に無用なエラーログが出る)。
// MigratorLive を依存として挟むことで、その fork 前に migration の完了を
// 待たせる(参照は MainLive の MigratorLive と同一なのでメモ化により 1 回だけ
// 実行される)。
const WorkerLive = TimeoutSweeperLive.pipe(
  Layer.provide(RunnerConfigLive),
  Layer.provide(ReposLive),
  Layer.provide(MigratorLive)
)

// finish (6-step) と backup (3-step) の Operation は同一 dispatcher に相乗り。
// stepKey の共通集合は BACKUP_STEP_KEYS ⊂ FINISH_STEP_KEYS。
const FINALIZATION_STEP_KEYS: ReadonlyArray<string> = [
  FINISH_STEP_KEYS.cancelQueued,
  FINISH_STEP_KEYS.waitRunning,
  FINISH_STEP_KEYS.writeScoreboardJson,
  FINISH_STEP_KEYS.writeScoreboardCsv,
  FINISH_STEP_KEYS.writeDbSnapshot,
  FINISH_STEP_KEYS.finishContest,
  BACKUP_STEP_KEYS.writeScoreboardJson,
  BACKUP_STEP_KEYS.writeScoreboardCsv,
  BACKUP_STEP_KEYS.writeDbSnapshot
]

// Task 7/8/9/10/11: Operation kind 別の step handler を登録する。
//  - reconcile: Cloudflare/Proxmox の inventory-driven cleanup
//  - enter_contest_mode: devvm → benchvm の graceful power transition
//  - prepare: preparing Contest の全 team を desiredInstanceCount まで
//    「1 台ずつ + memory recheck + KSM settle」で収束させる (Task 9)
//  - start: preparing → running の readiness 再検査 + saveIfRevision (Task 10)
//  - finish / backup: scheduled finalization + archive artifact 生成 (Task 11)
const OperationHandlerRegistryLive = Layer.effect(
  OperationHandlerRegistry,
  Effect.gen(function* () {
    const reconcileHandler = yield* makeReconciliationHandler
    const modeHandler = yield* makeEnterContestModeHandler
    const prepareHandler = yield* makePrepareHandler
    const startHandler = yield* makeStartContestHandler
    const finalizationHandler = yield* makeContestFinalizationHandler
    const enterModeStepKeys: ReadonlyArray<string> = ENTER_CONTEST_MODE_STEP_KEYS
    return {
      lookup: (kind, stepKey) => {
        if (kind === "reconcile" && stepKey.startsWith("reconcile:")) {
          return Option.some(reconcileHandler)
        }
        if (kind === "enter_contest_mode" && enterModeStepKeys.includes(stepKey)) {
          return Option.some(modeHandler)
        }
        if (kind === "prepare" && stepKey === PREPARE_STEP_KEY) {
          return Option.some(prepareHandler)
        }
        if (kind === "start" && stepKey === START_CONTEST_STEP_KEY) {
          return Option.some(startHandler)
        }
        if ((kind === "finish" || kind === "backup") && FINALIZATION_STEP_KEYS.includes(stepKey)) {
          return Option.some(finalizationHandler)
        }
        return Option.none()
      }
    }
  })
)

// OperationWorkerLive は DB のみに依存する(handler 登録は現状無し)。
// TimeoutSweeperLive と同じく MigratorLive を依存として明示し、migration 未完了
// のうちの 1 tick が "no such table" にならないようにする。
const OperationWorkerConditionalLive = OperationWorkerLive.pipe(
  Layer.provide(OperationWorkerConfigLive),
  Layer.provide(
    OperationHandlerRegistryLive.pipe(
      Layer.provide(InstancePortsLive),
      Layer.provide(ReposLive),
      Layer.provide(HostnameConfigLive),
      Layer.provide(ProvisioningConfigLive),
      // Task 9: prepare Operation の handler が使う KSM/PVE 待機設定。
      Layer.provide(PrepareConfigDefault),
      // Task 10: start Operation の handler が readiness を再計算するために
      // BackupPort / RunnerConfig を要求する (readiness の backup / runner check)。
      Layer.provide(BackupPortLive),
      Layer.provide(RunnerConfigLive)
    )
  ),
  Layer.provide(ReposLive),
  Layer.provide(MigratorLive)
)

// 払い出し/撤収オーケストレーションのワーカー(Task 4 レビュー I3)。
// ProvisionerLive の実行には実 port Live(ProxmoxLive / CloudflareLive /
// GithubKeysLive)が必要だが、その配線は上記 InstancePortsLive に共通化した
// (env 有無での実 Live/スタブの切替も含めて 1 箇所にまとめ、ApiLive と
// 二重構築しない)。ここではワーカー自体を起動するかどうかだけを
// PROXMOX_API_URL の有無で切り替える: 未設定ならスタブ port 越しに
// 空振りさせるのではなく、そもそもワーカーを起動しない no-op
// Layer(Layer.empty)にフォールバックする(dev/test や env 未設定の現行
// 本番でも HTTP サーバー自体の起動は壊さない)。
const ProvisionerConditionalLive = Layer.unwrapEffect(
  Config.option(Config.string("PROXMOX_API_URL")).pipe(
    Effect.map((proxmoxApiUrl) =>
      Option.isSome(proxmoxApiUrl)
        ? ProvisionerLive.pipe(
            Layer.provide(ProvisioningConfigLive),
            Layer.provide(ReposLive), // InstanceRepo / TeamRepo
            Layer.provide(InstancePortsLive),
            Layer.provide(MigratorLive)
          )
        : Layer.empty
    )
  )
)

// migration/seed は HttpLive・WorkerLive の依存(Layer.provide)経由で実行される
// (メモ化により 1 回だけ)。トップレベルにはそれらを消費するコンポーネント
// だけを並べ、順序は依存グラフに任せる。
const ContestSchedulerConditionalLive = ContestSchedulerLive.pipe(
  Layer.provide(ReposLive),
  Layer.provide(MigratorLive)
)

const MainLive = Layer.mergeAll(
  HttpLive,
  WorkerLive,
  ProvisionerConditionalLive,
  OperationWorkerConditionalLive,
  ContestSchedulerConditionalLive
)

Layer.launch(MainLive).pipe(NodeRuntime.runMain)
