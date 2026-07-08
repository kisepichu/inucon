# 調査メモ: Effect.ts 最新推奨作法(2026-07 時点)

日付: 2026-07-09
目的: Phase 2(ポータル)の設計・実装で使う Effect.ts の現行 API とバージョンの確定。
Web 調査(調査エージェント)の結果をそのまま記録する。情報源: effect.website 公式ドキュメント / 公式ブログ、Effect-TS/effect GitHub、npm registry、Effect-TS/examples、effect.solutions。

---

## 1. バージョン状況(2026-07 npm registry 実測)

| パッケージ | 最新安定 | 備考 |
|---|---|---|
| effect | **3.21.4** | 2026-06 公開。Schema 同梱(3.10 以降 `effect/Schema`) |
| @effect/platform | 0.96.x | HttpApi / HttpClient |
| @effect/platform-node | 0.107.0 | peer: effect ^3.21 |
| @effect/sql | 0.51.x | |
| @effect/sql-sqlite-node | 0.52.0 | better-sqlite3 ^12 ベース |
| @effect/vitest | 0.29.0 | peer: vitest ^3.2 |

**Effect v4 は 2026-02-18 に Beta 公開**(公式ブログ)。ランタイム全面書き換え(3x 高速・バンドル 70kB→20kB)、**全パッケージのバージョン統一**、platform/sql/rpc 等のコア機能を `effect` 本体(`effect/unstable/*`)へ統合、Schema 大幅刷新。ただし公式は「**本番は v3 が引き続き推奨**。v4 Beta は API 破壊があり得る。安定後は LTS 化、v3 はバグ修正・セキュリティ修正を継続(新機能は v4 のみ)」と明言(2026-04 InfoQ でも同旨)。**→ 本プロジェクトは v3(3.21.x)で開始が妥当。** v4 移行ガイド・Schema 移行ガイドは公開済み、codemod は後日提供予定。

## 2. サービス定義: Effect.Service / Context.Tag / Layer

現行(v3.9 以降、2024-10〜現在)の推奨:

- **アプリケーションサービス(実装が 1 つ+DI したい)** → `Effect.Service`。Tag + デフォルト Layer を一括定義。
- **インターフェースだけ先に切りたい / 実装が複数(ポート&アダプタ)** → `Context.Tag` + 実装ごとの `Layer`。DDD のリポジトリ interface はこちらが素直。
- 値だけ渡す(現在ユーザー等)→ `Context.Tag`(または `Context.Reference`)。

```ts
// Effect.Service(現行推奨形)
export class BenchQueue extends Effect.Service<BenchQueue>()("app/BenchQueue", {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return { enqueue: (jobId: string) => sql`...` } as const
  }),
  dependencies: [SqlLive], // → BenchQueue.Default / .DefaultWithoutDependencies
  // accessors: true も可
}) {}

// Context.Tag(interface と実装を分離する現行形)
export class TeamRepo extends Context.Tag("app/TeamRepo")<TeamRepo, {
  readonly findById: (id: TeamId) => Effect.Effect<Option.Option<Team>>
}>() {}
export const TeamRepoSqlite = Layer.effect(TeamRepo, Effect.gen(function* () { /* ... */ }))
```

注意点(effect.solutions, 2025–2026): メソッド型の `R` は `never` に保つ(依存は Layer 合成で解決)、パラメータ付き layer コンストラクタの結果は定数に保存(メモ化)、`provide` はアプリ最上位で一括。**旧形式**(`Context.Tag<Id, Service>()` の非クラス形、`Effect.gen(function* (_) { yield* _(Tag) })` の adapter 形)は v3.0(2024-05)以降不要で、現行は素の `yield* Tag`。

## 3. HTTP サーバー: HttpApi(@effect/platform 0.96, 2026-06 README 準拠)

```ts
// 定義(共有可能・クライアント導出可能)
const api = HttpApi.make("portal").add(
  HttpApiGroup.make("teams").add(
    HttpApiEndpoint.get("getTeam", "/teams/:id")
      .setPath(Schema.Struct({ id: Schema.NumberFromString }))
      .addSuccess(Team)
      .addError(TeamNotFound) // ステータスは HttpApiSchema.annotations({ status: 404 })
  )
)

// 実装(グループごとに Layer)
const TeamsLive = HttpApiBuilder.group(api, "teams", (handlers) =>
  handlers.handle("getTeam", ({ path: { id } }) => /* ... */))

// 起動(Node)
const HttpLive = HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
  Layer.provide(HttpApiSwagger.layer({ path: "/docs" })), // OpenAPI/Swagger UI 自動生成
  Layer.provide(HttpApiBuilder.api(api).pipe(Layer.provide(TeamsLive))),
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)
Layer.launch(HttpLive).pipe(NodeRuntime.runMain)
```

**認証ミドルウェア**(GitHub OAuth 後のセッション検証に使える現行形):

```ts
class CurrentUser extends Context.Tag("CurrentUser")<CurrentUser, User>() {}
class Authorization extends HttpApiMiddleware.Tag<Authorization>()("Authorization", {
  failure: Unauthorized,            // Schema.TaggedError + status 401
  provides: CurrentUser,
  security: { bearer: HttpApiSecurity.bearer } // apiKey / basic もあり
}) {}
// 実装は Layer.effect(Authorization, ...)、適用は endpoint/group に .middleware(Authorization)
```

OpenAPI 注釈は `.annotate(OpenApi.Description, ...)` 等。`HttpApiClient` で同一定義から型付きクライアントを導出可能(ベンチランナー側で使える)。

## 4. Schema(effect/Schema)

- **3.10(2024-10)以降 `import { Schema } from "effect"`。`@effect/schema` は廃止**(古い記事に注意)。
- ブランド型: `const TeamId = Schema.Number.pipe(Schema.brand("TeamId"))` / `TeamId.make(1)`。既存 `effect/Brand` は `Schema.fromBrand` で再利用。
- ドメインモデル: `Schema.Class` が定番。コンストラクタで検証、メソッド/getter 追加可、`Equal` 実装、`Person.fields` で再利用。

```ts
class BenchJob extends Schema.Class<BenchJob>("BenchJob")({
  id: JobId,
  status: Schema.Literal("pending", "running", "done", "failed"),
  score: Schema.OptionFromNullOr(Schema.Number)
}) {}
```

- リクエスト/レスポンス検証は HttpApiEndpoint の `setPath/setPayload/setUrlParams/addSuccess/addError` に Schema を渡すだけ(手動検証不要)。DB 行→ドメインは `Schema.decodeUnknown` か後述 SqlSchema。

## 5. @effect/sql + @effect/sql-sqlite-node(0.51/0.52, 2026-06)

```ts
// クライアント Layer
const SqlLive = SqliteClient.layer({ filename: "data/portal.db" })
// または layerConfig({ filename: Config.string("DB_PATH") })
// オプション: readonly / disableWAL / transformResultNames(snake→camel)等

// クエリ(タグ付きテンプレート、プレースホルダ化で injection 安全)
const rows = yield* sql<{ id: number }>`SELECT id FROM teams WHERE name = ${name}`

// マイグレーション: TypeScript の Effect を前方専用で
// migrations/00001_create_teams.ts → export default Effect.flatMap(SqlClient.SqlClient, sql => sql`CREATE TABLE ...`)
const MigratorLive = SqliteMigrator.layer({
  loader: SqliteMigrator.fromFileSystem(fileURLToPath(new URL("migrations", import.meta.url)))
}).pipe(Layer.provide(SqlLive))

// トランザクション(SqlClient interface で確認済み)
yield* sql.withTransaction(program) // Effect<A,E,R> → Effect<A, E | SqlError, R>
```

リポジトリ典型形: `Context.Tag`(interface)+ `Layer.effect` 内で `yield* SqlClient.SqlClient` して実装。行↔Schema 変換は `SqlSchema.findAll / single / findOne`、バッチは `SqlResolver.findById / ordered / grouped`。Effect-TS/examples の http-server も migrations ディレクトリ+Repo 層のこの構成。

## 6. エラーハンドリング

- ドメインエラー: `class JobNotFound extends Data.TaggedError("JobNotFound")<{ jobId: string }> {}`(現行)。
- HTTP 境界に載せるエラーは `Schema.TaggedError` + `HttpApiSchema.annotations({ status: 404 })` で定義し `.addError()` で宣言(シリアライズ可能になり OpenAPI にも出る)。
- 回復: `Effect.catchTag("JobNotFound", e => ...)` / `Effect.catchTags({ A: ..., B: ... })`。捕捉した型は E チャネルから消える。予期しない欠陥は `Effect.catchAllDefect` ではなく基本ログ+500 に任せる。

## 7. テスト: @effect/vitest 0.29(2026-06 README 準拠)

- `it.effect`: TestContext(**TestClock** 含む)自動注入。`yield* TestClock.adjust("1000 millis")` で時間を進める(ポーリングワーカーのテストに有効)。
- `it.live`: 実時間・実ログ。`it.scoped`: Scope 必要時。`it.effect.skip/only/fails`。
- 失敗検証は `Effect.exit` + `expect(result).toStrictEqual(Exit.succeed(...))`。
- Layer 差し替え: テストでは `program.pipe(Effect.provide(TeamRepoTest))` が基本。**高価な共有リソース(DB 接続等)のみ `it.layer`**(effect.solutions の推奨、既定は per-test の新規 Layer)。

## 8. 設定: Config / ConfigProvider

`yield* Config.string("HOST")`、`Config.number("PORT").pipe(Config.withDefault(8080))`、機密は **`Config.redacted`**(ログに `<redacted>`、`Redacted.value` で取り出し。GitHub OAuth の client secret に必須)。`Config.all + Config.map` で複合設定、検証は `Config.validate`。既定は環境変数プロバイダ、テストは `ConfigProvider.fromMap` + `Effect.withConfigProvider`。`layerConfig` 系(SqliteClient 等)に直接渡せる。

## 9. ロギング

`Effect.log / logDebug / logInfo / logWarning / logError`。最低レベルは `Logger.withMinimumLogLevel(LogLevel.Debug)`、構造化メタデータは `Effect.annotateLogs({ requestId })`(リクエストスコープに便利)、本番 JSON は `Logger.json`、開発は `Logger.pretty`(`Logger.replace(Logger.defaultLogger, ...)` を Layer で)。HttpApiBuilder.serve に `HttpMiddleware.logger` でアクセスログ。トレーシングは `Effect.withSpan`(@effect/sql はクエリ span 自動付与)。

## 10. プロジェクト構成(公式 Effect-TS/examples「http-server」実例、2026-07 確認)

公式サンプルの構成が DDD 志向とよく合う:

```
src/
  Domain/          # Schema.Class・ブランド型・ドメインエラー(Account.ts, Email.ts ...)
  Accounts/        # 機能単位: Api.ts(HttpApi 定義) Http.ts(HttpApiBuilder 実装)
                   #           Repo.ts(SQL) Policy.ts(認可)
  Groups/ People/  # 同上
  Api.ts           # 全グループを HttpApi.make(...).add(...) で合成
  Http.ts          # HttpApiBuilder.api + ミドルウェア合成
  Sql.ts           # SqliteClient.layer + Migrator layer
  main.ts          # composition root: Layer.mergeAll(...) → Layer.launch → NodeRuntime.runMain
  migrations/      # 番号付き TS マイグレーション
```

原則: 「HttpApi 定義(契約)」「ハンドラ実装」「リポジトリ」「ドメイン」をファイル分離し、**Layer の provide は main.ts の 1 箇所に集約**。

## 11. 外部 HTTP 呼び出し(GitHub OAuth): HttpClient

```ts
const exchangeCode = (code: string) => Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient
  const res = yield* HttpClientRequest.post("https://github.com/login/oauth/access_token").pipe(
    HttpClientRequest.setHeader("Accept", "application/json"),
    HttpClientRequest.bodyUrlParams({ client_id, client_secret, code }),
    client.execute
  )
  return yield* HttpClientResponse.schemaBodyJson(AccessTokenResponse)(res)
})
// 提供: NodeHttpClient.layer(platform-node)または FetchHttpClient.layer
```

`client.get(url)` の簡易形もあり。リトライは `HttpClient.retryTransient` / `Effect.retry(Schedule...)`、タイムアウトは `Effect.timeout`。GitHub API 呼び出しは `Effect.Service` でラップして Tag 化するのが定石(テストで差し替え可能に)。

## 12. 常駐処理(ベンチジョブキュー/ポーリング)

現行作法(v3):

```ts
// ワーカーを Layer として常駐させる(composition root で merge するだけ)
const WorkerLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const queue = yield* BenchQueue
    yield* processNext(queue).pipe(
      Effect.catchAllCause(Effect.logError),         // ワーカーを死なせない
      Effect.repeat(Schedule.spaced("1 second")),    // ポーリング
      Effect.forkScoped                              // Layer の Scope に紐付く fiber
    )
  })
)
```

- 周期実行: `Effect.repeat` + `Schedule.spaced / fixed / exponential / jittered`(合成可)。
- プロセス内キュー: `Queue.bounded<Job>(n)` + `Queue.offer / Queue.take`(take は待機)。ただしジョブの永続性が要るコンテストポータルでは **SQLite テーブルをキューにし HTTP ポーリング**(要件どおり)+ 排他は `withTransaction` + status 更新、が現実的。
- 常駐 fiber は `Effect.forkScoped`(Layer 管理下)か `Effect.forkDaemon`。`NodeRuntime.runMain` が SIGINT で全 fiber を interrupt し、`Effect.addFinalizer` / Scope で graceful shutdown。

## 新旧書き分けの要注意ポイント(記事の鮮度判定用)

| 古い(使わない) | 現行(v3.21) | 境界 |
|---|---|---|
| `Effect.gen(function* (_) { yield* _(x) })` | `Effect.gen(function* () { yield* x })` | v3.0 (2024-05) |
| `import { Schema } from "@effect/schema"` | `import { Schema } from "effect"` | v3.10 (2024-10) |
| `Context.Tag<Id, S>()` 非クラス形 / `Effect.Tag` | `class X extends Context.Tag("id")<X, S>() {}` / `Effect.Service`(3.9+) | 2024 |
| `Http.router` 手書きルータ中心の記事 | `HttpApi` 宣言的定義(OpenAPI/クライアント導出込み) | 2024 末〜 |
| v4 Beta 記事の `effect/unstable/http` 等 | v3 では `@effect/platform` のまま | v4 Beta (2026-02) |

**結論**: 2026-07 時点の新規本番開発は **effect 3.21.x + @effect/platform(-node) + @effect/sql-sqlite-node + @effect/vitest** で確定。v4 は Beta で追わない(安定後に移行ガイド+codemod で移行、パッケージ統合によりむしろ簡素化される)。

## Sources

- [Effect v4 Beta (公式ブログ, 2026-02-18)](https://effect.website/blog/releases/effect/40-beta/)
- [InfoQ: Effect v4 Beta (2026-04)](https://www.infoq.com/news/2026/04/effect-v4-beta/)
- [@effect/platform README (GitHub, main)](https://github.com/Effect-TS/effect/blob/main/packages/platform/README.md)
- [Managing Services (effect.website)](https://effect.website/docs/requirements-management/services/) / [Managing Layers](https://effect.website/docs/requirements-management/layers/) / [Effect 3.9 リリース](https://effect.website/blog/releases/effect/39/)
- [Effect Solutions: Services & Layers](https://www.effect.solutions/services-and-layers)
- [Schema Classes](https://effect.website/docs/schema/classes/) / [Advanced Usage(brand)](https://effect.website/docs/schema/advanced-usage/) / [Expected Errors](https://effect.website/docs/error-management/expected-errors/) / [Configuration](https://effect.website/docs/configuration/) / [Logging](https://effect.website/docs/observability/logging/)
- [@effect/sql README](https://github.com/Effect-TS/effect/blob/main/packages/sql/README.md) / [SqlClient API](https://effect-ts.github.io/effect/sql/SqlClient.ts.html) / [SqliteClient API](https://effect-ts.github.io/effect/sql-sqlite-node/SqliteClient.ts.html)
- [@effect/vitest README](https://github.com/Effect-TS/effect/blob/main/packages/vitest/README.md)
- [Effect-TS/examples http-server](https://github.com/Effect-TS/examples)
- npm registry(effect / @effect/platform-node / @effect/sql-sqlite-node / @effect/vitest、2026-07-09 実測)
