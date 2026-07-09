import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
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
import { ScoreboardLive } from "./infrastructure/http/handlers/scoreboard.js"
import { TeamsLive } from "./infrastructure/http/handlers/teams.js"
import { AdminOnlyLive, AuthenticationLive, RunnerAuthLive } from "./infrastructure/http/middleware.js"
import { makeStaticMiddleware } from "./infrastructure/http/static.js"
import { MigratorLive, SqlLive } from "./infrastructure/sql/client.js"
import { BenchJobRepoLive } from "./infrastructure/sql/repos/benchJobRepo.js"
import { ContestRepoLive } from "./infrastructure/sql/repos/contestRepo.js"
import { InstanceRepoLive } from "./infrastructure/sql/repos/instanceRepo.js"
import { SessionRepoLive } from "./infrastructure/sql/repos/sessionRepo.js"
import { TeamRepoLive } from "./infrastructure/sql/repos/teamRepo.js"
import { UserRepoLive } from "./infrastructure/sql/repos/userRepo.js"
import { UuidGenLive } from "./infrastructure/sql/uuid.js"
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
    Config.validate({
      message: "JOB_TIMEOUT_MILLIS must be a positive integer",
      validation: (n) => n > 0
    }),
    Effect.map((jobTimeoutMillis) => ({ jobTimeoutMillis }))
  )
)

const ApiLive = HttpApiBuilder.api(api).pipe(
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

// web/dist(portal/web の Vite ビルド成果物)へのパス。dist/main.js(ビルド後)
// と src/main.ts(tsx watch の開発時)はいずれも portal 直下の 1 階層下にある
// ため、"../web/dist" で両方から同じ portal/web/dist を指せる(static.ts の
// README 兼ねる)。
const webDistPath = fileURLToPath(new URL("../web/dist", import.meta.url))

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
  Layer.provide(MigratorLive)
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

const MainLive = Layer.mergeAll(HttpLive, MigratorLive, WorkerLive)

Layer.launch(MainLive).pipe(NodeRuntime.runMain)
