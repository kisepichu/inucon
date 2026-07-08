# INUCON Phase 2(ポータル + ベンチランナー)実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GitHub ログイン・ベンチキュー・スコアボードを持つポータル(apphost k3s)と、benchvm 常駐のベンチランナーを作り、Phase 1 の手動ベンチ運用を置き換える。

**Architecture:** 軽量ヘキサゴナル 3 層(domain 純粋 / application = ユースケース + port / infrastructure = adapter Layer)。DB FIFO キュー + pull 型ランナー。スペック: `docs/superpowers/specs/2026-07-09-phase2-portal-design.md`(必読)。

**Tech Stack:** TypeScript(strict)+ effect 3.21.x + @effect/platform(HttpApi)+ @effect/sql-sqlite-node + @effect/vitest、pnpm workspace、React + Vite。

## Global Constraints

- ライブラリバージョン(`docs/superpowers/research/2026-07-09-effect-ts-current-practices.md` で確定): `effect@^3.21.4`, `@effect/platform@^0.96.0`, `@effect/platform-node@^0.107.0`, `@effect/sql@^0.51.0`, `@effect/sql-sqlite-node@^0.52.0`, `@effect/vitest@^0.29.0`, `vitest@^3.2.0`。**Effect v4(Beta)の API(`effect/unstable/*`)は使わない**
- 旧 API 禁止: `Effect.gen(function* (_) { ... })` の adapter 形 / `@effect/schema` import / 非クラス形 `Context.Tag<Id, S>()`。現行形は調査メモの「新旧書き分け」表に従う
- 層の依存規則: `portal/src/domain/` は effect の **Schema / Either / Option / Data / Match のみ** import 可(`Effect.Effect` 型・Layer・Context は禁止)。`application/` は domain と port(Context.Tag)のみ。Layer 合成は `portal/src/main.ts` の 1 箇所
- キュー不変条件(スペック §BenchJob): チームごと queued+running 合計 1 本まで / 全体で running 1 本まで / targetIp はチームサブネット `10.100.<teamNumber>.0/24` 内のみ / enqueue は Contest が running のときのみ / cancel は queued のみ(running は 409)/ running が `JOB_TIMEOUT`(既定 10 分)進捗途絶で failed
- IP のサブネット判定は**オクテット単位の数値比較**で行う(文字列 prefix 比較は `10.100.1` が `10.100.10.5` に誤マッチするため禁止)
- セッション cookie: HttpOnly + Secure + SameSite=Lax、有効期限 30 日。OAuth は `state` 必須検証。secret 類(GITHUB_CLIENT_SECRET / RUNNER_TOKEN)は `Config.redacted`
- テスト: domain は素の vitest、Effect 絡みは `it.effect`(時間は TestClock)。DB テストは SQLite `:memory:` + Migrator
- コミットは `/commit` スキル(`git commit --no-gpg-sign`)。タスクごとに develop からブランチ → PR → `/pr-review` → マージ(Phase 1 と同じ運用)
- 各タスクの実装者は着手前にスペックの該当節を読むこと(このファイルと同じ PR でマージ済み)

## ファイル構造(全体像)

```
pnpm-workspace.yaml / package.json / tsconfig.base.json
shared/               # API 契約(HttpApi 定義と境界 Schema)
  package.json / tsconfig.json
  src/api.ts  src/schemas.ts
portal/
  package.json / tsconfig.json / vitest.config.ts
  src/domain/       ids.ts contest.ts team.ts user.ts instance.ts benchJob.ts subnet.ts errors.ts
  src/application/  ports.ts usecases/{bench.ts,auth.ts,teams.ts,contest.ts,scoreboard.ts}
  src/infrastructure/
    sql/            client.ts migrations/0001_initial.ts repos/{userRepo.ts,sessionRepo.ts,teamRepo.ts,contestRepo.ts,instanceRepo.ts,benchJobRepo.ts}
    github/         oauth.ts
    http/           handlers/{health.ts,auth.ts,teams.ts,instances.ts,contest.ts,bench.ts,runner.ts,scoreboard.ts,admin.ts} middleware.ts static.ts
    worker/         timeoutSweeper.ts
  src/main.ts
  web/              # React + Vite SPA
runner/
  package.json / tsconfig.json
  src/main.ts src/loop.ts src/adapters/{types.ts,privateIsu.ts}
deploy/             # k3s マニフェスト + Dockerfile + runbook
```

---

### Task 1: pnpm workspace + ポータル walking skeleton

**目的:** ツールチェーン(pnpm/TS/effect/vitest)と「HttpApi + SQLite + Migrator + テスト」の縦串を最小構成で貫通させ、フレームワークの想定齟齬を最初に潰す(スペックのリスク節)。

**Files:**
- Create: `pnpm-workspace.yaml`, ルート `package.json`, `tsconfig.base.json`, `.gitignore` 追記(`node_modules/`, `dist/`, `*.db`)
- Create: `shared/package.json`, `shared/tsconfig.json`, `shared/src/api.ts`, `shared/src/schemas.ts`
- Create: `portal/package.json`, `portal/tsconfig.json`, `portal/vitest.config.ts`
- Create: `portal/src/infrastructure/sql/client.ts`, `portal/src/infrastructure/sql/migrations/0001_initial.ts`(このタスクでは users/sessions のみ。Task 4 で全量に拡張)
- Create: `portal/src/infrastructure/http/handlers/health.ts`, `portal/src/main.ts`
- Test: `portal/test/http/health.test.ts`

**Interfaces(後続タスクが依存):**
- Produces: `shared/src/api.ts` の `export const api = HttpApi.make("inucon")...`(グループは以後のタスクが追記していく)
- Produces: `SqlLive`(`SqliteClient.layerConfig({ filename: Config.string("DB_PATH").pipe(Config.withDefault("data/portal.db")) })`)と `MigratorLive`(`client.ts`)
- Produces: `main.ts` の composition root 形(`Layer.mergeAll` → `HttpApiBuilder.serve` → `NodeRuntime.runMain`)

- [ ] **Step 1: workspace とパッケージ雛形**

`pnpm-workspace.yaml`:

```yaml
packages:
  - shared
  - portal
  - runner
```

ルート `package.json`(private, scripts: `test: pnpm -r test`, `typecheck: pnpm -r typecheck`)。`tsconfig.base.json` は `strict: true`, `module: nodenext`, `target: es2022`, `moduleResolution: nodenext`。`shared` と `portal` の package.json は Global Constraints のバージョンで依存を宣言(portal は `shared: workspace:*` も)。

- [ ] **Step 2: health エンドポイントの失敗テストを書く**

`portal/test/http/health.test.ts`(`@effect/vitest` の `it.effect`): テスト用 Layer 一式(SqlTest = `:memory:` + Migrator、HttpApi ハンドラ)を組み、`HttpApiClient.make(api)` 経由で `GET /api/health` を呼び `{ status: "ok" }` を得る。実装が無いのでコンパイルエラー/失敗になることを `pnpm --filter portal test` で確認。

- [ ] **Step 3: 実装**

`shared/src/api.ts`:

```ts
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { Schema } from "effect"

export const healthGroup = HttpApiGroup.make("health").add(
  HttpApiEndpoint.get("get", "/api/health").addSuccess(
    Schema.Struct({ status: Schema.Literal("ok") })
  )
)
export const api = HttpApi.make("inucon").add(healthGroup)
```

`client.ts` は `SqliteClient.layerConfig` + `SqliteMigrator.layer({ loader: fromFileSystem(migrations dir) })`(調査メモ §5 の形)。`0001_initial.ts` は users / sessions の 2 テーブル(DDL は Task 4 の全量 DDL から該当 2 つを先取り。カラムは Task 4 の表と一致させること)。`health.ts` は `HttpApiBuilder.group(api, "health", handlers => handlers.handle("get", () => Effect.succeed({ status: "ok" as const })))`。`main.ts` は調査メモ §3 の起動形。

- [ ] **Step 4: テスト・typecheck を通す** — `pnpm -r typecheck && pnpm -r test` 全緑。`pnpm --filter portal dev`(tsx watch)で起動し `curl localhost:3000/api/health` も確認
- [ ] **Step 5: /commit → /pr → /pr-review → マージ**

---

### Task 2: domain 層(集約 + 状態遷移関数)

**目的:** スペックの集約 4 つと不変条件を、純粋な Schema + 遷移関数として実装する。**このタスクに I/O は一切ない。**

**Files:**
- Create: `portal/src/domain/ids.ts`, `errors.ts`, `subnet.ts`, `user.ts`, `team.ts`, `contest.ts`, `instance.ts`, `benchJob.ts`
- Test: `portal/test/domain/{subnet,contest,benchJob}.test.ts`(素の vitest)

**Interfaces:**
- Produces(以後の全タスクが使う。**名前・型はここが正**):

```ts
// ids.ts — 全 ID は UUID 文字列のブランド型
export const UserId = Schema.String.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type
// 同様に TeamId, ContestId, InstanceId, BenchJobId, SessionId

// errors.ts — Data.TaggedError(データのみ、Effect runtime 非依存)
export class InvalidContestTransition extends Data.TaggedError("InvalidContestTransition")<{ from: ContestStatus; to: ContestStatus }> {}
export class InvalidJobTransition extends Data.TaggedError("InvalidJobTransition")<{ jobId: BenchJobId; from: BenchJobStatus; action: string }> {}
export class CannotCancelRunning extends Data.TaggedError("CannotCancelRunning")<{ jobId: BenchJobId }> {}
export class TargetIpOutOfSubnet extends Data.TaggedError("TargetIpOutOfSubnet")<{ ip: string; teamNumber: number }> {}
export class TeamJobAlreadyQueued extends Data.TaggedError("TeamJobAlreadyQueued")<{ teamId: TeamId }> {}
export class ContestNotRunning extends Data.TaggedError("ContestNotRunning")<{ status: ContestStatus }> {}

// subnet.ts
export const ipInTeamSubnet: (ip: string, teamNumber: number) => boolean
export const validateBenchTarget: (ip: string, teamNumber: number) => Either.Either<void, TargetIpOutOfSubnet>

// contest.ts
export type ContestStatus = "preparing" | "running" | "finished"
export class Contest extends Schema.Class<Contest>("Contest")({ id: ContestId, name: Schema.String, problemKey: Schema.String, status: Schema.Literal("preparing", "running", "finished") }) {}
export const startContest: (c: Contest) => Either.Either<Contest, InvalidContestTransition>   // preparing→running
export const finishContest: (c: Contest) => Either.Either<Contest, InvalidContestTransition>  // running→finished

// user.ts / team.ts / instance.ts
export class User extends Schema.Class<User>("User")({ id: UserId, githubId: Schema.Number, githubLogin: Schema.String, displayName: Schema.String, isAdmin: Schema.Boolean }) {}
export class Team extends Schema.Class<Team>("Team")({ id: TeamId, name: Schema.String, teamNumber: Schema.Number.pipe(Schema.int(), Schema.between(1, 254)) }) {}
export class Instance extends Schema.Class<Instance>("Instance")({ id: InstanceId, teamId: TeamId, index: Schema.Number, privateIp: Schema.String, status: Schema.Literal("active") }) {}

// benchJob.ts — 時刻は epoch ミリ秒(number)
export type BenchJobStatus = "queued" | "running" | "finished" | "canceled" | "failed"
export class BenchJob extends Schema.Class<BenchJob>("BenchJob")({
  id: BenchJobId, teamId: TeamId,
  targetIp: Schema.String, targetPort: Schema.Number,
  status: Schema.Literal("queued", "running", "finished", "canceled", "failed"),
  score: Schema.OptionFromNullOr(Schema.Number), passed: Schema.OptionFromNullOr(Schema.Boolean),
  errorMessage: Schema.OptionFromNullOr(Schema.String),
  enqueuedAt: Schema.Number, startedAt: Schema.OptionFromNullOr(Schema.Number),
  finishedAt: Schema.OptionFromNullOr(Schema.Number), lastProgressAt: Schema.OptionFromNullOr(Schema.Number)
}) {}
export const checkEnqueueAllowed: (args: { contest: Contest; activeJobCountForTeam: number; teamNumber: number; targetIp: string })
  => Either.Either<void, ContestNotRunning | TeamJobAlreadyQueued | TargetIpOutOfSubnet>
export const newJob: (args: { id: BenchJobId; teamId: TeamId; targetIp: string; targetPort: number; now: number }) => BenchJob // status: queued
export const startJob: (job: BenchJob, now: number) => Either.Either<BenchJob, InvalidJobTransition>          // queued→running(startedAt/lastProgressAt = now)
export const recordProgress: (job: BenchJob, now: number) => Either.Either<BenchJob, InvalidJobTransition>    // running のみ(lastProgressAt 更新)
export const finishJob: (job: BenchJob, result: { score: number; passed: boolean }, now: number) => Either.Either<BenchJob, InvalidJobTransition> // running→finished
export const failJob: (job: BenchJob, message: string, now: number) => Either.Either<BenchJob, InvalidJobTransition>  // running→failed
export const cancelJob: (job: BenchJob) => Either.Either<BenchJob, CannotCancelRunning | InvalidJobTransition>        // queued→canceled のみ
export const isTimedOut: (job: BenchJob, now: number, timeoutMillis: number) => boolean  // running かつ lastProgressAt+timeout < now
```

- [ ] **Step 1: 失敗テストを書く。**ケースは最低限以下(値まで具体的に):
  - subnet: `ipInTeamSubnet("10.100.1.11", 1) === true` / `("10.100.2.11", 1) === false` / **`("10.100.10.5", 1) === false`(prefix 誤マッチ検出)** / `("10.100.1.999", 1) === false`(不正オクテット)/ `("::1", 1) === false`
  - contest: preparing→start→running→finish→finished が成功、`startContest(running)` と `finishContest(preparing)` が `Either.left(InvalidContestTransition)`
  - benchJob: `checkEnqueueAllowed` の 4 分岐(contest preparing → ContestNotRunning / activeJobCountForTeam=1 → TeamJobAlreadyQueued / 外部 IP → TargetIpOutOfSubnet / 全て満たす → right)。`startJob(queued)` 成功・`startJob(running)` left。`cancelJob(queued)` 成功・`cancelJob(running)` は `CannotCancelRunning`・`cancelJob(finished)` は left。`finishJob`/`failJob` は running からのみ。`isTimedOut`: running + lastProgressAt=0, now=600_001, timeout=600_000 → true、599_999 → false、queued → 常に false
- [ ] **Step 2: テストが失敗することを確認**(`pnpm --filter portal test`)
- [ ] **Step 3: 実装。**遷移関数は `job.status` の分岐(`Match.value` か素朴な switch)+ `new BenchJob({ ...job, ... })` のイミュータブル更新。subnet は `ip.split(".")` → 4 要素・各 0-255 の整数(先頭ゼロ許容しない `/^\d{1,3}$/` + Number 変換)→ `[10, 100, teamNumber]` と前 3 オクテット一致
- [ ] **Step 4: テスト全緑 + typecheck**
- [ ] **Step 5: /commit → /pr → /pr-review → マージ**

---

### Task 3: application 層(port + キュー系ユースケース)

**目的:** port(Context.Tag)を宣言し、キューの不変条件を守る中核ユースケースをインメモリ port でテストする。

**Files:**
- Create: `portal/src/application/ports.ts`, `portal/src/application/usecases/bench.ts`
- Test: `portal/test/application/bench.test.ts`(インメモリ port Layer は `portal/test/support/inMemory.ts` に)

**Interfaces:**
- Produces(`ports.ts` — リポジトリ契約。Task 4 が実装する。メソッドの R は never、E は `SqlError` を包む `RepoError`(`Data.TaggedError("RepoError")<{ cause: unknown }>`)に統一):

```ts
export class UuidGen extends Context.Tag("app/UuidGen")<UuidGen, { readonly next: Effect.Effect<string> }>() {}
export class ContestRepo extends Context.Tag("app/ContestRepo")<ContestRepo, {
  readonly getCurrent: Effect.Effect<Option.Option<Contest>, RepoError>
  readonly save: (c: Contest) => Effect.Effect<void, RepoError>
}>() {}
export class UserRepo extends Context.Tag("app/UserRepo")<UserRepo, {
  readonly upsertByGithub: (u: { githubId: number; githubLogin: string; displayName: string; isAdmin: boolean }) => Effect.Effect<User, RepoError>
  readonly findById: (id: UserId) => Effect.Effect<Option.Option<User>, RepoError>
}>() {}
export class SessionRepo extends Context.Tag("app/SessionRepo")<SessionRepo, {
  readonly create: (userId: UserId, expiresAt: number) => Effect.Effect<string, RepoError>  // 戻り値 = sessionId(乱数はここで生成)
  readonly findValidUser: (sessionId: string, now: number) => Effect.Effect<Option.Option<User>, RepoError>
  readonly delete: (sessionId: string) => Effect.Effect<void, RepoError>
}>() {}
export class TeamRepo extends Context.Tag("app/TeamRepo")<TeamRepo, {
  readonly list: Effect.Effect<ReadonlyArray<Team>, RepoError>
  readonly findById: (id: TeamId) => Effect.Effect<Option.Option<Team>, RepoError>
  readonly findByUserId: (id: UserId) => Effect.Effect<Option.Option<Team>, RepoError>
  readonly create: (t: Team) => Effect.Effect<void, RepoError>
  readonly setMembers: (teamId: TeamId, userIds: ReadonlyArray<UserId>) => Effect.Effect<void, RepoError>
  readonly listMembers: (teamId: TeamId) => Effect.Effect<ReadonlyArray<User>, RepoError>
}>() {}
export class InstanceRepo extends Context.Tag("app/InstanceRepo")<InstanceRepo, {
  readonly listByTeam: (teamId: TeamId) => Effect.Effect<ReadonlyArray<Instance>, RepoError>
  readonly create: (i: Instance) => Effect.Effect<void, RepoError>
  readonly remove: (id: InstanceId) => Effect.Effect<void, RepoError>
}>() {}
export class BenchJobRepo extends Context.Tag("app/BenchJobRepo")<BenchJobRepo, {
  readonly insertIfAllowed: (job: BenchJob) => Effect.Effect<BenchJob, RepoError | TeamJobAlreadyQueued>
    // 「チームに queued/running なし」の再検証と INSERT を同一トランザクションで行う(TOCTOU 回避)
  readonly findById: (id: BenchJobId) => Effect.Effect<Option.Option<BenchJob>, RepoError>
  readonly listByTeam: (teamId: TeamId, limit: number) => Effect.Effect<ReadonlyArray<BenchJob>, RepoError>
  readonly dequeueNextQueued: (now: number) => Effect.Effect<Option.Option<BenchJob>, RepoError>
    // 全体 running=0 のときだけ先頭 queued を running 化(アトミック)
  readonly save: (job: BenchJob) => Effect.Effect<void, RepoError>
  readonly appendLog: (id: BenchJobId, chunk: string) => Effect.Effect<void, RepoError>
  readonly getLog: (id: BenchJobId) => Effect.Effect<string, RepoError>
  readonly listRunningOlderThan: (cutoff: number) => Effect.Effect<ReadonlyArray<BenchJob>, RepoError>  // lastProgressAt < cutoff
  readonly scoreboard: Effect.Effect<ReadonlyArray<{ teamId: TeamId; teamName: string; latestScore: number | null; bestScore: number | null; latestAt: number | null }>, RepoError>
}>() {}
export class GithubOAuthPort extends Context.Tag("app/GithubOAuthPort")<GithubOAuthPort, {
  readonly authorizeUrl: (state: string) => string
  readonly exchangeCodeForUser: (code: string) => Effect.Effect<{ githubId: number; githubLogin: string; displayName: string }, OAuthFailed>
}>() {}
export class RunnerConfig extends Context.Tag("app/RunnerConfig")<RunnerConfig, { readonly jobTimeoutMillis: number }>() {}
```

- Produces(`usecases/bench.ts`): `enqueueBench`, `cancelBench`, `pollNextJob`, `reportProgress`, `reportFinish`, `sweepTimedOutJobs`

- [ ] **Step 1: 失敗テストを書く**(`it.effect` + インメモリ port。時刻は `Clock.currentTimeMillis`、テストは TestClock で制御):
  - enqueueBench: 正常系(queued ジョブが返る)/ contest が preparing → `ContestNotRunning` / 既に自チームに queued あり → `TeamJobAlreadyQueued` / 他チームサブネットの IP → `TargetIpOutOfSubnet`
  - cancelBench: 自チームの queued → canceled / running → `CannotCancelRunning` / 他チームのジョブ → `Forbidden`(application エラー、`errors.ts` に追加: `class Forbidden extends Data.TaggedError("Forbidden")<{}> {}`)
  - pollNextJob: queued 2 本(team1 が古い)→ team1 のジョブが running で返り、もう一度 poll すると `Option.none`(全体 1 本制約)
  - reportFinish: running → finished(score/passed 保存)。queued に対する finish は `InvalidJobTransition`
  - sweepTimedOutJobs: running で lastProgressAt が 10 分前 → failed(errorMessage="timeout")、直近進捗ありは無傷
- [ ] **Step 2: 失敗確認**
- [ ] **Step 3: 実装。**`enqueueBench` の形(これが正):

```ts
export const enqueueBench = (args: { user: User; targetIp: string; targetPort: number }) =>
  Effect.gen(function* () {
    const contest = yield* ContestRepo.pipe(Effect.flatMap(r => r.getCurrent), Effect.flatMap(Option.match({ onNone: () => Effect.fail(new ContestNotRunning({ status: "preparing" })), onSome: Effect.succeed })))
    const team = yield* TeamRepo.pipe(Effect.flatMap(r => r.findByUserId(args.user.id)), Effect.flatMap(Option.match({ onNone: () => Effect.fail(new NotInTeam({})), onSome: Effect.succeed })))
    const jobs = yield* BenchJobRepo
    yield* Either.match(checkEnqueueAllowed({ contest, activeJobCountForTeam: 0, teamNumber: team.teamNumber, targetIp: args.targetIp }), { onLeft: Effect.fail, onRight: Effect.succeed })
    // activeJobCountForTeam の最終判定は insertIfAllowed がトランザクション内で行う(上の 0 は contest/subnet 検証のための呼び出し)
    const id = BenchJobId.make(yield* UuidGen.pipe(Effect.flatMap(g => g.next)))
    const now = yield* Clock.currentTimeMillis
    return yield* jobs.insertIfAllowed(newJob({ id, teamId: team.id, targetIp: args.targetIp, targetPort: args.targetPort, now }))
  })
```

(`NotInTeam` も `errors.ts` に追加。)他ユースケースも同型: repo 取得 → domain 遷移関数(`Either.match` で E チャネルへ)→ save。`sweepTimedOutJobs` は `listRunningOlderThan(now - jobTimeoutMillis)` → 各ジョブに `failJob(job, "timeout", now)` → save、件数を返す。

- [ ] **Step 4: テスト全緑 + typecheck**
- [ ] **Step 5: /commit → /pr → /pr-review → マージ**

---

### Task 4: SQLite リポジトリ(全 migration + port 実装)

**Files:**
- Modify: `portal/src/infrastructure/sql/migrations/0001_initial.ts`(全 8 テーブルに拡張。Task 1 の 2 テーブル定義は変えない — まだ本番 DB が無いので 0001 を書き換えてよいのは Phase 2 リリース前の今だけ、とコメントで明記)
- Create: `portal/src/infrastructure/sql/repos/*.ts`(port ごと)+ `portal/src/infrastructure/sql/uuid.ts`(UuidGen Live = `crypto.randomUUID`)
- Test: `portal/test/infrastructure/repos.test.ts`(`:memory:` + Migrator、`it.layer` で共有)

**DDL(0001_initial.ts、これが正):**

```sql
CREATE TABLE users (id TEXT PRIMARY KEY, github_id INTEGER NOT NULL UNIQUE, github_login TEXT NOT NULL, display_name TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, team_number INTEGER NOT NULL UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE team_members (team_id TEXT NOT NULL REFERENCES teams(id), user_id TEXT NOT NULL UNIQUE REFERENCES users(id), PRIMARY KEY (team_id, user_id));
CREATE TABLE contests (id TEXT PRIMARY KEY, name TEXT NOT NULL, problem_key TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('preparing','running','finished')));
CREATE TABLE instances (id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), idx INTEGER NOT NULL, private_ip TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, UNIQUE (team_id, idx));
CREATE TABLE bench_jobs (id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), target_ip TEXT NOT NULL, target_port INTEGER NOT NULL DEFAULT 80, status TEXT NOT NULL CHECK (status IN ('queued','running','finished','canceled','failed')), score INTEGER, passed INTEGER, error_message TEXT, enqueued_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, last_progress_at INTEGER);
CREATE INDEX idx_bench_jobs_status ON bench_jobs (status, enqueued_at);
CREATE INDEX idx_bench_jobs_team ON bench_jobs (team_id, enqueued_at DESC);
CREATE TABLE bench_job_logs (job_id TEXT PRIMARY KEY REFERENCES bench_jobs(id), log TEXT NOT NULL DEFAULT '');
```

**キモ 2 点(SQL は同一トランザクション `sql.withTransaction` 内で):**

- `insertIfAllowed`: `SELECT COUNT(*) FROM bench_jobs WHERE team_id = ? AND status IN ('queued','running')` が 0 のときのみ INSERT(+ `bench_job_logs` に空行 INSERT)。0 でなければ `TeamJobAlreadyQueued`
- `dequeueNextQueued`:

```sql
UPDATE bench_jobs SET status='running', started_at=?1, last_progress_at=?1
WHERE id = (SELECT id FROM bench_jobs WHERE status='queued'
            AND NOT EXISTS (SELECT 1 FROM bench_jobs WHERE status='running')
            ORDER BY enqueued_at, id LIMIT 1)
RETURNING *;
```

- [ ] **Step 1: 失敗テストを書く。**各 repo の基本 CRUD に加え必須ケース: dequeue FIFO 順序 / running 存在時に dequeue が none / insertIfAllowed の重複拒否 / appendLog が追記になる / scoreboard(2 チーム × 複数 finished ジョブで latest と best が正しい。best は `MAX(score)`、latest は `finished_at` 最大の行の score。canceled/failed は集計対象外)/ `findValidUser` が期限切れセッションで none
- [ ] **Step 2: 失敗確認**
- [ ] **Step 3: 実装。**行→ドメインは `Schema.decodeUnknown(BenchJob)` 等(snake→camel は `transformResultNames` を使わず SELECT の AS で明示的に合わせる — 変換の魔法より可読性優先)。`SessionRepo.create` の sessionId は `crypto.randomBytes(32).toString("hex")`
- [ ] **Step 4: テスト全緑 + typecheck**
- [ ] **Step 5: /commit → /pr → /pr-review → マージ**

---

### Task 5: GitHub OAuth + セッション + 認証ミドルウェア

**Files:**
- Create: `portal/src/infrastructure/github/oauth.ts`(GithubOAuthPort の Live: HttpClient で token 交換 → `GET https://api.github.com/user`)
- Create: `portal/src/application/usecases/auth.ts`(`handleOAuthCallback`, `logout`, `getMe`)
- Create: `portal/src/infrastructure/http/middleware.ts`(`Authentication` / `AdminOnly` / `RunnerAuth` の HttpApiMiddleware)
- Create: `portal/src/infrastructure/http/handlers/auth.ts`
- Modify: `shared/src/api.ts`(auth グループ追加)、`portal/src/main.ts`
- Test: `portal/test/application/auth.test.ts`, `portal/test/http/auth.test.ts`(GithubOAuthPort はスタブ Layer)

**仕様(スペック §認証):**
- `GET /auth/github`: `state` = 32byte 乱数を発行、`inucon_oauth_state` cookie(HttpOnly, Secure, SameSite=Lax, Max-Age=600)に保存し、GitHub authorize URL へ 302
- `GET /auth/github/callback?code&state`: state 不一致/欠落 → 400。成功時: exchangeCodeForUser → `UserRepo.upsertByGithub`(`isAdmin` は `ADMIN_GITHUB_LOGINS` に含まれるか)→ `SessionRepo.create`(30 日)→ `inucon_session` cookie 設定 → `/` へ 302
- `POST /api/auth/logout`: セッション削除 + cookie 破棄。`GET /api/me`: `{ user, team | null }`
- **スパイク step(最初にやる):** リダイレクト + Set-Cookie を返すエンドポイントを HttpApi でどう書くかを確認する。HttpApiEndpoint の success に `HttpApiSchema.Empty`(302 注釈)を使う方法と、`HttpApiBuilder.serve` の前段に素の `HttpRouter`(`/auth/*` のみ)を挟む方法を試し、**動いた方を採用して PR 説明に記録**(スペックのリスク節に対応)。`HttpApiBuilder.middlewareCors` 等既存 API を優先し、無理筋なら素 Router で良い
- `Authentication` ミドルウェア: cookie の sessionId → `SessionRepo.findValidUser` → `CurrentUser`(Context.Tag)提供。失敗は 401 `Unauthorized`
- 環境変数: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`(redacted), `ADMIN_GITHUB_LOGINS`, `BASE_URL`, `RUNNER_TOKEN`(redacted)

- [ ] **Step 1: スパイク**(上記。結果を `portal/src/infrastructure/http/README.md` に 3 行で記録)
- [ ] **Step 2: 失敗テスト**(callback 正常系で users 行と session cookie / state 不一致 400 / me が team 込みで返る / 期限切れセッション 401 / AdminOnly が非 admin を 403 / RunnerAuth が bearer 不一致を 401)
- [ ] **Step 3: 実装 → テスト全緑**
- [ ] **Step 4: /commit → /pr → /pr-review → マージ**

---

### Task 6: チーム / インスタンス / コンテスト管理 API

**Files:**
- Create: `portal/src/application/usecases/{teams.ts,contest.ts}`、`portal/src/infrastructure/http/handlers/{teams.ts,instances.ts,contest.ts,admin.ts}`
- Modify: `shared/src/api.ts`, `shared/src/schemas.ts`, `portal/src/main.ts`
- Test: `portal/test/http/teams.test.ts`(HttpApiClient で一連)

**エンドポイント仕様(スペック §HTTP API の表が正。要点):**
- `GET /api/contest`(セッション): 現在のコンテスト。無ければ 404
- `GET /api/teams`(セッション): チーム一覧(メンバーの githubLogin 込み)
- `POST /api/teams`(admin): `{ name, teamNumber }`。teamNumber 重複は 409
- `PUT /api/teams/:id/members`(admin): `{ githubLogins: string[] }`。**未ログインの GitHub アカウントは登録不可**(users に居ない login は 422 で一覧を返す。先にユーザーがログインしておく運用)
- `GET /api/teams/:id/instances`(当該チームメンバー or admin。他チームは 403)
- `POST /api/instances`(admin): `{ teamId, index, privateIp }`。privateIp がチームサブネット外なら 422(domain の `validateBenchTarget` を流用)
- `DELETE /api/instances/:id`(admin)
- `POST /api/admin/contest/start` / `POST /api/admin/contest/finish`(admin): domain の遷移関数経由。不正遷移は 409

- [ ] **Step 1: 失敗テスト**(上記の権限・バリデーション分岐を網羅。ログインは Task 5 のスタブ OAuth でセッションを作るテストヘルパー `portal/test/support/login.ts` を作って使い回す)
- [ ] **Step 2: 失敗確認 → 実装 → 全緑**
- [ ] **Step 3: /commit → /pr → /pr-review → マージ**

---

### Task 7: ベンチ API + runner API

**Files:**
- Create: `portal/src/infrastructure/http/handlers/{bench.ts,runner.ts}`
- Modify: `shared/src/api.ts`, `shared/src/schemas.ts`(runner 契約はランナーが `HttpApiClient` で使うため **shared に置くのが必須**)、`portal/src/main.ts`
- Test: `portal/test/http/bench.test.ts`

**shared の runner 契約(これが正):**

```ts
export const RunnerJob = Schema.Struct({
  id: Schema.String, teamId: Schema.String,
  targetIp: Schema.String, targetPort: Schema.Number, problemKey: Schema.String
})
// POST /api/runner/jobs/poll    → 200 { job: RunnerJob | null }
// POST /api/runner/jobs/:id/progress { logChunk: string, partialScore: number | null } → 204。job が running でなければ 409
// POST /api/runner/jobs/:id/finish   { passed: boolean, score: number, errorMessage: string | null, logTail: string } → 204。
//   passed/score は成功時、実行自体の失敗(バイナリ異常終了等)は errorMessage 付き・passed=false, score=0。running でなければ 409
```

- bench グループ(スペックの表どおり): enqueue は `{ instanceId | targetIp+targetPort }` を受け、instanceId 指定時は InstanceRepo から IP を解決。ジョブ詳細のログは **自チーム or admin のみ**(他チームは 403、スコア一覧は全員可)
- progress 受信で `recordProgress` + `appendLog`。finish 受信で `finishJob`/`failJob` + `appendLog(logTail)`
- problemKey は現在のコンテストから取る(RunnerJob に載せて、ランナーがアダプタを選ぶ)

- [ ] **Step 1: 失敗テスト**(enqueue→poll→progress→finish の正常系 1 本 / poll が空キューで `{ job: null }` / 二重 poll で 2 本目 null / progress の 409 / 他チームのログ 403 / cancel 済みジョブは poll に出ない)
- [ ] **Step 2: 失敗確認 → 実装 → 全緑**
- [ ] **Step 3: /commit → /pr → /pr-review → マージ**

---

### Task 8: タイムアウト回収ワーカー + スコアボード + E2E

**Files:**
- Create: `portal/src/infrastructure/worker/timeoutSweeper.ts`, `portal/src/application/usecases/scoreboard.ts`, `portal/src/infrastructure/http/handlers/scoreboard.ts`
- Modify: `shared/src/api.ts`, `portal/src/main.ts`(WorkerLive を merge)
- Test: `portal/test/worker/timeoutSweeper.test.ts`(TestClock)、`portal/test/e2e/benchFlow.test.ts`

**timeoutSweeper(調査メモ §12 の形、これが正):**

```ts
export const TimeoutSweeperLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    yield* sweepTimedOutJobs.pipe(
      Effect.tap(n => n > 0 ? Effect.logWarning(`timed out ${n} bench job(s)`) : Effect.void),
      Effect.catchAllCause(Effect.logError),
      Effect.repeat(Schedule.spaced("30 seconds")),
      Effect.forkScoped
    )
  })
)
```

- `GET /api/scoreboard`(セッション): `BenchJobRepo.scoreboard` をそのまま返す
- E2E: テスト Layer 一式で「admin がチーム作成 → メンバー割当 → instance 登録 → contest start → メンバーが enqueue → runner poll → progress×2 → finish → scoreboard に score 反映 → ジョブ詳細でログ全文」を HttpApiClient で 1 本通す

- [ ] **Step 1: 失敗テスト**(sweeper: TestClock で 30 秒×N 進めて、10 分無進捗の running ジョブが failed になり直近進捗ジョブは無傷 / E2E 上記)
- [ ] **Step 2: 失敗確認 → 実装 → 全緑**
- [ ] **Step 3: /commit → /pr → /pr-review → マージ**

---

### Task 9: ベンチランナー(benchvm 常駐プロセス)

**Files:**
- Create: `runner/package.json`, `runner/tsconfig.json`, `runner/vitest.config.ts`
- Create: `runner/src/adapters/types.ts`, `runner/src/adapters/privateIsu.ts`, `runner/src/loop.ts`, `runner/src/main.ts`
- Test: `runner/test/loop.test.ts`(ポータルはスタブ Layer)、`runner/test/privateIsu.test.ts`(パーサ単体)

**アダプタ契約(types.ts、スペック §問題アダプタ):**

```ts
export interface ProblemAdapter {
  readonly problemKey: string
  readonly command: (target: { ip: string; port: number }) => { readonly cmd: string; readonly args: ReadonlyArray<string>; readonly cwd: string }
  readonly parseResult: (stdout: string) => Either.Either<BenchResult, AdapterParseError>
  readonly parsePartialScore: (stdoutSoFar: string) => Option.Option<number>
}
export interface BenchResult { readonly passed: boolean; readonly score: number; readonly messages: ReadonlyArray<string> }
```

**privateIsu.ts:** `cmd: "./bin/benchmarker"`, `args: ["-u", "./userdata", "-t", \`http://${ip}:${port}/\`]`, `cwd: BENCH_DIR`(env、既定 `/home/kise/bench`。実パスは `problems/private-isu/README.md` のベンチ実行節を確認して合わせる)。`parseResult` は stdout の**最後の `{` 始まり行**を JSON.parse し `{ pass, score, messages }` → `{ passed: pass, score, messages }`。パース不能は `AdapterParseError`。`parsePartialScore` は private-isu では `Option.none`(途中スコア出力なし)

**loop.ts:** `HttpApiClient.make(api, { baseUrl: PORTAL_URL })` + bearer RUNNER_TOKEN で:
poll → job なし: 2 秒 sleep(`Schedule.spaced`)→ 再 poll。job あり: `Command.make`(@effect/platform)で起動 → stdout/stderr を蓄積しつつ **5 秒ごとに増分を progress POST**(`Effect.fork` したタイマー fiber、`Effect.ensuring` で止める)→ プロセス終了で parseResult → finish POST(パース不能・非ゼロ exit は `passed:false, score:0, errorMessage`)。ループ全体は `Effect.catchAllCause(logError)` で不死身に。progress/finish の POST 失敗は 3 回リトライ(`Effect.retry(Schedule.exponential("1 second").pipe(Schedule.compose(Schedule.recurs(3))))`)して落ちたらログだけ残して次へ

- [ ] **Step 1: 失敗テスト**(parseResult: 実ベンチ出力サンプル(Phase 1 の README から score 1030 台の実出力を転記)で passed/score が取れる、ゴミ入り stdout で最後の JSON 行を拾う、JSON なしで left / loop: スタブポータルで「poll→実行(echo で偽ベンチ)→progress≥1 回→finish」)
- [ ] **Step 2: 失敗確認 → 実装 → 全緑**(偽ベンチは `node -e` で JSON を吐く 1 行スクリプトを adapter 差し替えで)
- [ ] **Step 3: /commit → /pr → /pr-review → マージ**

---

### Task 10: フロントエンド SPA + 静的配信

**Files:**
- Create: `portal/web/`(Vite react-ts テンプレート。`pnpm create vite` 相当の構成を手書きで): `package.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/api.ts`(fetch ラッパ、credentials: "same-origin")、`src/pages/{Login,Scoreboard,Team,JobDetail,Admin}.tsx`
- Create: `portal/src/infrastructure/http/static.ts`(`web/dist` の配信: `/assets/*` はファイル、その他非 `/api`・非 `/auth` パスは `index.html`。パストラバーサル対策として resolve 後に dist 配下チェック)
- Modify: `portal/src/main.ts`, ルート `package.json`(build スクリプト: web build → portal build)

**ページ仕様(最小。CSS はフレームワークなし・素朴で良い):**
- Login: 未ログイン時に表示。「GitHub でログイン」→ `/auth/github`
- Scoreboard(`/`): チーム名・最新スコア・最高スコア・最終実行時刻の表。10 秒ごと再取得。ヘッダにコンテスト名と状態、自分の名前、logout
- Team(`/team`): 自チームのインスタンス一覧(名前 = `inucon-team{N}-{M}`、IP)/ ベンチ対象選択(インスタンスのドロップダウン + 「IP:port 直接入力」トグル)/ 実行ボタン(実行不可時は理由表示: コンテスト未開催・実行中ジョブあり)/ ジョブ履歴表(状態・スコア・時刻、行クリックで詳細へ)
- JobDetail(`/jobs/:id`): 状態・スコア・エラー・ログ(`<pre>`)。status が queued/running の間は 5 秒ポーリング
- Admin(`/admin`、isAdmin のみリンク表示): チーム作成フォーム / メンバー割当(githubLogin をカンマ区切り入力)/ インスタンス登録・削除 / contest start/finish ボタン
- ルーティングは `react-router-dom` v7。サーバー状態はポーリングごと fetch で十分(TanStack Query は使わない — 依存最小)

- [ ] **Step 1: web 雛形 + api.ts + Login/Scoreboard を実装**(`pnpm --filter web build` が通り、portal 経由で表示されるところまで)
- [ ] **Step 2: Team/JobDetail/Admin を実装**
- [ ] **Step 3: 検証** — `pnpm -r typecheck && pnpm -r test` + ローカルで「スタブ OAuth でログイン → admin でチーム作成 → enqueue → (手動で runner API を curl して) スコアボード反映」を通し、スクリーンショットを PR に添付
- [ ] **Step 4: /commit → /pr → /pr-review → マージ**

---

### Task 11: デプロイ(apphost k3s + benchvm systemd)+ seed

**Files:**
- Create: `deploy/Dockerfile`(multi-stage: `node:22-slim` + pnpm → web build + portal build → 実行イメージは `node dist/main.js`)
- Create: `deploy/k8s/{namespace,deployment,service,ingress,pvc}.yaml`(namespace `inucon`、replicas=1、PVC `local-path` 1Gi を `/data` に、`DB_PATH=/data/portal.db`、secret `inucon-portal-env` から env 注入)
- Create: `deploy/README.md`(runbook: イメージ build/push、secret 作成、apply 手順、cloudflared ホスト名追加手順)
- Create: `portal/src/infrastructure/sql/seed.ts`(起動時: contests が空なら `{ name: "INUCON", problemKey: "private-isu", status: "preparing" }` を INSERT — 冪等)
- 別リポジトリ `nixos-config-private`: `hosts/benchvm` に runner の systemd サービス(git checkout + `pnpm install --prod` + `node runner/dist/main.js`、env は agenix の `runner-token.age` ほか)。apphost の cloudflared に `inucon.kisen.one → k3s ingress` を追加

**注意:**
- イメージは `ghcr.io/kisepichu/inucon-portal`。パッケージを public にして imagePullSecret を不要にする(private にする場合は runbook に手順を書く)
- eevee/apphost/benchvm への SSH・kubectl・Cloudflare 操作が必要。**資格情報が足りない場合は BLOCKED として報告し、勝手に回避しない**(Phase 1 と同じ運用)
- GitHub OAuth App の作成(callback URL `https://inucon.kisen.one/auth/github/callback`)はブラウザ作業のためユーザーに依頼する

- [ ] **Step 1: Dockerfile + manifests + seed を書く**(ローカルで `docker build` と `docker run` + `/api/health` 確認)
- [ ] **Step 2: apphost にデプロイ**(runbook を書きながら実施。`https://inucon.kisen.one/api/health` が通ること)
- [ ] **Step 3: benchvm に runner を配置**(systemd 起動、ポータルへの poll がログで確認できること)
- [ ] **Step 4: /commit → /pr → /pr-review → マージ**(nixos-config-private 側も PR)

---

### Task 12: 本番検証(Phase 1 手動フローの置き換え)

- [ ] **Step 1:** GitHub OAuth App 設定・admin ログイン・チーム 2 つ + Terraform 済みインスタンスの台帳登録・contest start
- [ ] **Step 2:** 実ベンチをポータル経由で 3 回実行し、Phase 1 の実測(score 1030±1%、fail 0)と同水準であること・進捗ログが流れること・スコアボード反映を確認
- [ ] **Step 3:** 異常系 2 つを実測: (a) ベンチ実行中の cancel が 409、(b) runner を殺して 10 分後に failed へ回収
- [ ] **Step 4:** 結果をスペックの「リスク・未確認事項」節と `deploy/README.md` に追記。Phase 2 完了を親スペックのフェーズ計画に記録
- [ ] **Step 5: /commit → /pr → /pr-review → マージ**

---

## Self-Review(執筆時に実施済み)

- スペック全節とタスクの対応: ドメインモデル→Task 2、アーキテクチャ→全体構成、認証→Task 5、API→Task 6/7/8、キュー→Task 3/4、ランナー/アダプタ→Task 9、DB→Task 4、フロント→Task 10、デプロイ→Task 11、テスト戦略→各タスク、マイルストーン 6(本番検証)→Task 12。取りこぼしなし
- 型整合: `BenchJob`/port のシグネチャは Task 2/3 で定義し、Task 4 以降はそれを参照(名前の再定義なし)
- 既知の不確実点はタスク内に明示(Task 5 のスパイク、Task 9 の BENCH_DIR、Task 11 の資格情報)
