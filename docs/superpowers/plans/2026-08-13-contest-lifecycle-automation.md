# Contest Lifecycle Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 第1回を履歴として保持したまま、Admin Web から第 n 回の作成、準備、開始、自動終了、結果確定、外部リソース撤収を安全に反復できるようにする。

**Architecture:** 現行 portal の Effect + DDD + SQLite 構成に開催回スコープと永続 Operation worker を追加する。外部変更は plan/apply、ResourceBinding、provider inventory によって再開可能かつ監査可能にし、Cloudflare/Proxmox/runner/backup を backend の port 経由で操作する。credential は sibling repository `../nixos-config-private` の agenix を source of truth とし、ブラウザには渡さない。

**Tech Stack:** TypeScript 5.7、Effect 3.21、@effect/platform、@effect/sql-sqlite-node、SQLite、React 19、Vite、Vitest、Proxmox VE API、Cloudflare API v4、NixOS、agenix、k3s。

## Global Constraints

- ユーザーは開催回をまたいで再利用し、Team、TeamMember、TeamInvite、Instance、BenchJob、scoreboard は Contest ごとに分離する。
- Contest は `draft -> preparing -> running -> finalizing -> finished`、`draft|preparing -> canceled` の一方向遷移とする。
- `preparing`、`running`、`finalizing` の Contest は全体で最大1件とする。
- start は admin の明示操作だけで行い、scheduledEndAt 到達時の finalizing は worker が自動実行する。
- 第2回の1チーム、quota 3、desiredInstanceCount 3、約7日間は設定値であり、第2回専用コードにしない。
- `private-isu` の既存 template VMID 9100 を使い、新問題 template build は Web 自動化しない。
- 現行の利用可能 team network slot は team1/team2。slot 追加と benchvm NIC/NixOS network 拡張は runbook に残す。
- 外部変更は read-only plan、plan digest、Contest revision、明示 apply の順で行う。
- ポータル所有 resource だけを自動修復・削除し、binding のない legacy resource は hostname ごとの adopt 確認を必要とする。
- Cloudflare Tunnel catch-all と INUCON 以外の DNS/ingress/Access resource は変更しない。
- Access allow policy は当該 Contest Team の正確な email 集合へ収束させ、過去開催の email と和集合にしない。
- credential、Authorization header、Access email 一覧、OAuth secret、SSH key を Operation log、HTTP response、Git、Nix store に残さない。
- 実装・検証中は対話ブラウザタブを開かず、Vitest/Vite build/API/headless check で確認する。参加者認証の最終実測だけを開催前 runbook の人手確認に残す。
- force stop は行わず、devvm/benchvm は guest shutdown と状態確認を使う。
- SQLite schema migration は forward-only。本番適用前に application-consistent snapshot と snapshot copy 上の dry-run を必須とする。
- 実装は TDD、task ごとの小さな commit、`pnpm -r typecheck` と `pnpm -r test` の継続成功を維持する。例外は schema と全 repository call site を同時に切り替える Tasks2-3 の1 atomic commit とする。

## File and Responsibility Map

### Shared contract

- `shared/src/schemas.ts`: Contest、Team、BenchJob、Operation、Readiness、Reconciliation、Artifact の wire schema。
- `shared/src/api.ts`: public archive、contest-scoped API、admin plan/apply、runner heartbeat の endpoint 契約。

### Domain and application

- `portal/src/domain/contest.ts`: Contest entity、schedule invariant、状態遷移。
- `portal/src/domain/operation.ts`: Operation/OperationStep 状態機械。
- `portal/src/domain/resourceBinding.ts`: 外部 resource ownership。
- `portal/src/domain/reconciliation.ts`: desired/observed diff と分類。
- `portal/src/domain/artifact.ts`: archive artifact metadata。
- `portal/src/application/ports.ts`: repository/provider/backup/operation handler interfaces。
- `portal/src/application/usecases/contestAdmin.ts`: draft、編成コピー、更新、preparing/start/cancel。
- `portal/src/application/usecases/reconciliation.ts`: inventory、canonical plan、adopt、cleanup step。
- `portal/src/application/usecases/readiness.ts`: start/prepare gate の集約。
- `portal/src/application/usecases/operations.ts`: Operation 作成、step 実行、retry。
- `portal/src/application/usecases/finalization.ts`: scheduled end、job drain、artifact 確定。
- `portal/src/application/usecases/archives.ts`: scoreboard JSON/CSV と DB snapshot metadata。

### Infrastructure

- `portal/src/infrastructure/sql/migrations/0004_contest_lifecycle.ts`: Contest lifecycle columns と第1回 metadata backfill。
- `portal/src/infrastructure/sql/migrations/0005_multi_contest.ts`: Team/Invite/Instance/BenchJob の Contest scope schema。
- `portal/src/infrastructure/sql/migrations/0006_operations.ts`: Operation、ResourceBinding、Artifact、RunnerAgent schema。
- `portal/src/infrastructure/sql/repos/*.ts`: contest-scoped query と新 repository。
- `portal/src/infrastructure/proxmox/client.ts`: VM/node/network/service inventory と mode power primitive。
- `portal/src/infrastructure/cloudflare/client.ts`: sanitized inventory と exact Access policy。
- `portal/src/infrastructure/backup/sqlite.ts`: better-sqlite3 backup、SHA-256、artifact path guard。
- `portal/src/infrastructure/worker/operationWorker.ts`: global single-operation durable worker。
- `portal/src/infrastructure/worker/contestScheduler.ts`: scheduled end/access close/cleanup sweep。
- `portal/src/infrastructure/http/handlers/*.ts`: new API handler。
- `portal/src/main.ts`: repository、port、worker、handler Layer wiring。

### Web

- `portal/web/src/pages/Contests.tsx`: 開催一覧と archive selector。
- `portal/web/src/pages/ContestSetup.tsx`: 5-step draft wizard。
- `portal/web/src/pages/ContestAdmin.tsx`: overview/teams/readiness/reconciliation/operations/archive tabs。
- `portal/web/src/pages/OperationDetail.tsx`: durable step/attempt/error 表示。
- `portal/web/src/pages/Scoreboard.tsx`: contest selector と selected archive。
- `portal/web/src/api.ts`, `portal/web/src/App.tsx`, `portal/web/src/index.css`: API wrapper、route、layout。

### Deployment and private NixOS config

- `deploy/k8s/backup-pvc.yaml`: server-side snapshot/artifact PVC。
- `deploy/k8s/deployment.yaml`: `/backups` mount と env。
- `../nixos-config-private/secrets/{inucon-portal-env,inucon-proxmox-provision,inucon-proxmox-mode,runner-env,inucon-tunnel-token}.age`: ciphertext。
- `../nixos-config-private/secrets/secrets.nix`: recipient rules。
- `../nixos-config-private/hosts/apphost/configuration.nix`: runtime k3s Secret sync。
- `../nixos-config-private/hosts/benchvm/configuration.nix`: age-backed EnvironmentFile。
- `docs/runbooks/contest-operations.md`, `docs/runbooks/contest-recovery.md`, `deploy/README.md`: normal flow と block condition recovery。

---

### Task 1: Contest lifecycle and wire types

**Files:**
- Modify: `portal/src/domain/ids.ts`
- Modify: `portal/src/domain/contest.ts`
- Modify: `portal/src/domain/errors.ts`
- Modify: `portal/src/application/usecases/contest.ts`
- Create: `portal/src/infrastructure/sql/migrations/0004_contest_lifecycle.ts`
- Modify: `portal/src/infrastructure/sql/repos/contestRepo.ts`
- Modify: `portal/src/infrastructure/sql/seed.ts`
- Modify: `shared/src/schemas.ts`
- Create: `portal/test/support/factories.ts`
- Modify: `portal/test/application/bench.test.ts`
- Modify: `portal/test/application/provisioning.test.ts`
- Modify: `portal/test/e2e/benchFlow.test.ts`
- Modify: `portal/test/http/bench.test.ts`
- Modify: `portal/test/http/contest.test.ts`
- Modify: `portal/test/http/instances.test.ts`
- Modify: `portal/test/infrastructure/repos.test.ts`
- Modify: `portal/test/infrastructure/seed.test.ts`
- Create: `portal/test/infrastructure/migration0004.test.ts`
- Test: `portal/test/domain/contest.test.ts`

**Interfaces:**
- Consumes: existing branded ID and `Schema.Class` conventions.
- Produces:

```ts
export type ContestStatus = "draft" | "preparing" | "running" | "finalizing" | "finished" | "canceled"
export class Contest extends Schema.Class<Contest>("Contest")({
  id: ContestId,
  edition: Schema.Int.pipe(Schema.positive()),
  name: Schema.String,
  problemKey: Schema.String,
  problemRevision: Schema.String,
  templateVmid: Schema.Int.pipe(Schema.positive()),
  status: Schema.Literal("draft", "preparing", "running", "finalizing", "finished", "canceled"),
  instanceQuota: Schema.Int.pipe(Schema.positive()),
  scheduledStartAt: Schema.OptionFromNullOr(Schema.Int),
  scheduledEndAt: Schema.OptionFromNullOr(Schema.Int),
  accessClosesAt: Schema.OptionFromNullOr(Schema.Int),
  cleanupAt: Schema.OptionFromNullOr(Schema.Int),
  startedAt: Schema.OptionFromNullOr(Schema.Int),
  finalizingAt: Schema.OptionFromNullOr(Schema.Int),
  finishedAt: Schema.OptionFromNullOr(Schema.Int),
  canceledAt: Schema.OptionFromNullOr(Schema.Int),
  revision: Schema.Int.pipe(Schema.positive())
}) {}

export const beginPreparation: (contest: Contest) => Either.Either<Contest, InvalidContestTransition | InvalidContestSchedule>
export const startContest: (contest: Contest, now: number) => Either.Either<Contest, InvalidContestTransition>
export const beginFinalization: (contest: Contest, now: number) => Either.Either<Contest, InvalidContestTransition>
export const finishContest: (contest: Contest, now: number) => Either.Either<Contest, InvalidContestTransition>
export const cancelContest: (contest: Contest, now: number) => Either.Either<Contest, InvalidContestTransition>
```

- All domain timestamps remain epoch milliseconds, matching existing code.
- Contest call sites switch to `portal/test/support/factories.ts` in tests; `makeContest(overrides)` supplies a draft-compatible default without weakening the production schema.

- [ ] **Step 1: Write failing lifecycle and Contest-schema migration tests**

```ts
it("draft -> preparing requires a complete ordered schedule", () => {
  const draft = contest({ status: "draft", scheduledStartAt: Option.some(100), scheduledEndAt: Option.some(200), accessClosesAt: Option.some(200) })
  expect(Either.isRight(beginPreparation(draft))).toBe(true)
  expect(Either.isLeft(beginPreparation(contest({ status: "draft", scheduledStartAt: Option.some(200), scheduledEndAt: Option.some(100), accessClosesAt: Option.some(200) })))).toBe(true)
})

it("running -> finalizing -> finished records actual timestamps", () => {
  const finalizing = Either.getOrThrow(beginFinalization(contest({ status: "running" }), 300))
  expect(finalizing.finalizingAt).toEqual(Option.some(300))
  const finished = Either.getOrThrow(finishContest(finalizing, 400))
  expect(finished.status).toBe("finished")
  expect(finished.finishedAt).toEqual(Option.some(400))
})

```

In `migration0004.test.ts`, build a 0001-0003 legacy database with one finished Contest and assert the migration preserves ID/name/problem/status/quota while adding edition1, template9100, `legacy-2026-07-08`, null schedules/timestamps, and revision1. Also cover a fresh zero-Contest database and rejection of more than one legacy Contest.

- [ ] **Step 2: Run the focused tests and verify the new fields/migration are absent**

Run: `pnpm --filter portal exec vitest run test/domain/contest.test.ts test/infrastructure/migration0004.test.ts`

Expected: FAIL on missing Contest fields/transitions and missing `0004_contest_lifecycle.ts`.

- [ ] **Step 3: Implement the forward-only Contest table rebuild**

Rebuild only `contests` into the full Task1 shape with checked statuses, unique positive edition, positive revision/template/quota, and the partial single-operational index. Backfill the single legacy row exactly as edition1/template9100/`legacy-2026-07-08`; preserve its old status and nullable schedule. Zero rows produce the empty new table. Count rows and run `PRAGMA foreign_key_check` before commit; more than one row or a mismatch throws a self-contained `MigrationDataError`.

- [ ] **Step 4: Implement lifecycle, schedule validation, and revision increment**

Every successful mutation returns a new Contest with `revision + 1`. `beginPreparation` requires non-null scheduledStartAt/scheduledEndAt/accessClosesAt, rejects `scheduledStartAt >= scheduledEndAt`, `accessClosesAt < scheduledEndAt`, and non-null `cleanupAt < accessClosesAt`. `cancelContest` accepts only draft/preparing.

```ts
const mutate = (contest: Contest, fields: Omit<Partial<Contest>, "id" | "revision">): Contest =>
  new Contest({ ...contest, ...fields, revision: contest.revision + 1 })
```

- [ ] **Step 5: Update Contest decoding, use cases, shared schema, and all constructors**

Keep domain `Option` and wire `null` conventions identical to existing `User.email`. `contestRepo` maps every DB column explicitly. `startContestUsecase` and `finishContestUsecase` obtain epoch milliseconds from Effect `Clock`. As a temporary compatibility bridge, the existing finish endpoint applies `beginFinalization` and then `finishContest` in one use-case save; Task 11 replaces that bridge with the durable finalization Operation. Add `OperationId`, `OperationStepId`, `ResourceBindingId`, and `ArtifactId` branded strings to both domain IDs and shared schemas for later tasks. Add `makeContest(overrides)` and replace every test-side `new Contest` so the task finishes with no type errors.

- [ ] **Step 6: Run migration/domain/repository tests and all typechecks**

Run: `pnpm --filter portal exec vitest run test/domain/contest.test.ts test/infrastructure/migration0004.test.ts test/http/contest.test.ts test/infrastructure/repos.test.ts test/infrastructure/seed.test.ts && pnpm -r typecheck`

Expected: focused tests PASS and every workspace typecheck PASS.

- [ ] **Step 7: Commit Task 1**

```bash
git add portal/src/domain/ids.ts portal/src/domain/contest.ts portal/src/domain/errors.ts portal/src/application/usecases/contest.ts portal/src/infrastructure/sql/migrations/0004_contest_lifecycle.ts portal/src/infrastructure/sql/repos/contestRepo.ts portal/src/infrastructure/sql/seed.ts shared/src/schemas.ts portal/test/support/factories.ts portal/test/domain/contest.test.ts portal/test/application/bench.test.ts portal/test/application/provisioning.test.ts portal/test/e2e/benchFlow.test.ts portal/test/http/bench.test.ts portal/test/http/contest.test.ts portal/test/http/instances.test.ts portal/test/infrastructure/migration0004.test.ts portal/test/infrastructure/repos.test.ts portal/test/infrastructure/seed.test.ts
git commit --no-gpg-sign -m "feat(contest): define multi-edition lifecycle"
```

---

### Task 2: Forward-only contest-scoping migration (atomic part 1 of 2)

**Files:**
- Create: `portal/src/infrastructure/sql/migrations/0005_multi_contest.ts`
- Create: `portal/test/infrastructure/migration0005.test.ts`
- Modify: `portal/src/infrastructure/sql/seed.ts`
- Modify: `portal/test/infrastructure/seed.test.ts`
- Modify: `portal/test/support/inMemory.ts`

**Interfaces:**
- Consumes: migrations 0001-0004 and Task 1 Contest schema.
- Produces the following schema invariants:

```sql
UNIQUE(contests.edition)
UNIQUE(teams.id, teams.contest_id)
UNIQUE(teams.contest_id, teams.team_number)
UNIQUE(team_members.contest_id, team_members.user_id)
UNIQUE(team_invites.contest_id, team_invites.github_login)
FOREIGN KEY(team_id, contest_id) REFERENCES teams(id, contest_id)
CREATE UNIQUE INDEX idx_contests_single_operational
  ON contests ((1)) WHERE status IN ('preparing', 'running', 'finalizing');
```

- Contest metadata was backfilled by 0004 and is not rewritten. Each legacy Team's `desired_instance_count` equals its non-deleted Instance count capped by edition1 `instance_quota`; every existing job gets `purpose='competition'`.

- [ ] **Step 1: Write migration fixture tests before the migration file exists**

Seed migrations 0001-0003 with one finished contest, two teams, two members, one invite, one running instance, finished/failed jobs and logs; apply 0004 then 0005. Assert after 0005:

```ts
expect(contests).toStrictEqual([{ edition: 1, templateVmid: 9100, problemRevision: "legacy-2026-07-08", status: "finished" }])
expect(await count(sql, "teams")).toBe(2)
expect(await count(sql, "instances")).toBe(1)
expect(await count(sql, "bench_jobs")).toBe(2)
expect(await sql`PRAGMA foreign_key_check`).toEqual([])
```

Also assert the same user can join teams in different contests, duplicate membership inside one contest is rejected, and applying 0001-0005 to a fresh database with no seed data succeeds with zero contests. The single-operational-Contest index remains covered by Task1's migration test.

- [ ] **Step 2: Run migration tests and verify module-not-found failure**

Run: `pnpm --filter portal exec vitest run test/infrastructure/migration0005.test.ts`

Expected: FAIL because `0005_multi_contest.ts` does not exist.

- [ ] **Step 3: Implement table rebuild in dependency-safe order**

Keep the Task1 `contests` table unchanged. Create `teams_new` and every scoped child `*_new` table first with composite `(team_id, contest_id)` foreign keys into `teams_new(id, contest_id)`. If there is one legacy Contest, copy all rows with `contest_id` obtained through their Team. If there are zero contests, require every scoped legacy table to be empty and build an empty new schema. Verify source/destination counts before dropping anything. Drop old child tables in this order: `bench_job_logs`, `team_members`, `team_invites`, `instances`, `bench_jobs`, then `teams`; rename `teams_new` before its child tables and recreate indexes. Throw `MigrationDataError` on a zero-contest database containing scoped rows, more than one legacy Contest, count mismatch, orphan relation, or `PRAGMA foreign_key_check` output.

```ts
const [{ legacyContestCount }] = yield* sql<{ legacyContestCount: number }>`SELECT COUNT(*) AS legacyContestCount FROM contests`
if (legacyContestCount > 1) {
  yield* Effect.fail(new MigrationDataError({ message: `migration 0005 supports zero fresh contests or one legacy contest, found ${legacyContestCount}` }))
}
```

- [ ] **Step 4: Stop seeding an implicit contest on fresh databases**

`SeedLive` must no longer create `INUCON / private-isu`. A fresh DB intentionally has zero contests until an admin creates a draft; production retains its migrated legacy row. Update seed tests to assert repeated SeedLive execution leaves contest count zero.

- [ ] **Step 5: Run migration and repository regression tests**

Run: `pnpm --filter portal exec vitest run test/infrastructure/migration0005.test.ts test/infrastructure/migration0004.test.ts test/infrastructure/migration0003.test.ts test/infrastructure/migration0002.test.ts test/infrastructure/seed.test.ts`

Expected: all migration and seed tests PASS.

- [ ] **Step 6: Keep the green migration change uncommitted and continue immediately to Task 3**

Do not create an intermediate commit or deployable revision: the stricter NOT NULL Contest columns intentionally require the repository/application updates in Task3. Task3's full regression run and single commit cover both atomic parts.

---

### Task 3: Contest-scoped repositories and authorization lookup (atomic part 2 of 2)

**Files:**
- Modify: `portal/src/domain/team.ts`
- Modify: `portal/src/domain/teamInvite.ts`
- Modify: `portal/src/domain/instance.ts`
- Modify: `portal/src/domain/benchJob.ts`
- Modify: `shared/src/schemas.ts`
- Modify: `portal/src/application/ports.ts`
- Modify: `portal/src/application/usecases/teams.ts`
- Modify: `portal/src/application/usecases/invites.ts`
- Modify: `portal/src/application/usecases/instances.ts`
- Modify: `portal/src/application/usecases/bench.ts`
- Modify: `portal/src/application/usecases/provisioning.ts`
- Modify: `portal/src/application/usecases/contest.ts`
- Modify: `portal/src/application/usecases/scoreboard.ts`
- Modify: `portal/src/infrastructure/http/handlers/auth.ts`
- Modify: `portal/src/infrastructure/http/handlers/teams.ts`
- Modify: `portal/src/infrastructure/http/handlers/instances.ts`
- Modify: `portal/src/infrastructure/http/handlers/bench.ts`
- Modify: `portal/src/infrastructure/http/handlers/runner.ts`
- Modify: `portal/src/infrastructure/http/handlers/admin.ts`
- Modify: `portal/src/infrastructure/http/handlers/contest.ts`
- Modify: `portal/src/infrastructure/http/handlers/scoreboard.ts`
- Modify: `portal/src/infrastructure/sql/repos/contestRepo.ts`
- Modify: `portal/src/infrastructure/sql/repos/teamRepo.ts`
- Modify: `portal/src/infrastructure/sql/repos/inviteRepo.ts`
- Modify: `portal/src/infrastructure/sql/repos/instanceRepo.ts`
- Modify: `portal/src/infrastructure/sql/repos/benchJobRepo.ts`
- Modify: `portal/src/application/usecases/auth.ts`
- Modify: `portal/test/infrastructure/repos.test.ts`
- Modify: `portal/test/support/inMemory.ts`
- Modify: `portal/test/support/inMemoryPhase3Ports.test.ts`
- Modify: `portal/test/support/apiTestHelpers.ts`
- Modify: `portal/test/application/auth.test.ts`
- Modify: `portal/test/application/invites.test.ts`
- Modify: `portal/test/application/bench.test.ts`
- Modify: `portal/test/application/provisioning.test.ts`
- Modify: `portal/test/http/auth.test.ts`
- Modify: `portal/test/http/teams.test.ts`
- Modify: `portal/test/http/instances.test.ts`
- Modify: `portal/test/http/invites.test.ts`
- Modify: `portal/test/http/bench.test.ts`
- Modify: `portal/test/http/contest.test.ts`
- Modify: `portal/test/http/scoreboard.test.ts`

**Interfaces:**
- Consumes: the uncommitted Task2 schema and tests; the combined commit is the first deployable multi-contest revision.
- Produces:

- `Team`, `TeamInvite`, `Instance`, and `BenchJob` gain `contestId`; Team gains `desiredInstanceCount`; BenchJob gains `purpose: "rehearsal" | "competition"`.

```ts
ContestRepo.list: Effect<ReadonlyArray<Contest>, RepoError>
ContestRepo.findById(id: ContestId): Effect<Option<Contest>, RepoError>
ContestRepo.getOperational: Effect<Option<Contest>, RepoError>
ContestRepo.getDisplay: Effect<Option<Contest>, RepoError>
ContestRepo.create(contest: Contest): Effect<void, RepoError | ContestEditionConflict | OperationalContestConflict>
ContestRepo.saveIfRevision(contest: Contest, expectedRevision: number): Effect<Contest, RepoError | ContestRevisionConflict>

TeamRepo.listByContest(contestId: ContestId): Effect<ReadonlyArray<Team>, RepoError>
TeamRepo.findById(contestId: ContestId, teamId: TeamId): Effect<Option<Team>, RepoError>
TeamRepo.findByUserId(contestId: ContestId, userId: UserId): Effect<Option<Team>, RepoError>
TeamRepo.addMember(contestId: ContestId, teamId: TeamId, userId: UserId): Effect<boolean, RepoError>

InviteRepo.listByGithubLogin(login: string): Effect<ReadonlyArray<TeamInvite>, RepoError>
InstanceRepo.listByContest(contestId: ContestId): Effect<ReadonlyArray<Instance>, RepoError>
BenchJobRepo.scoreboard(contestId: ContestId): Effect<ReadonlyArray<ScoreboardRow>, RepoError>
```

All TeamRepo, InviteRepo, InstanceRepo and BenchJobRepo writes include contest ID in conditional SQL, not only in a preceding application read. Compatibility handlers without an explicit ContestId resolve `getOperational`, falling back to `getDisplay`; `/api/me` returns the user's Team in that resolved Contest.

- [ ] **Step 1: Write repository isolation tests**

```ts
it.effect("scoreboard never mixes editions", () => Effect.gen(function* () {
  yield* seedFinishedJob({ contestId: c1, teamId: t1, score: 100 })
  yield* seedFinishedJob({ contestId: c2, teamId: t2, score: 900 })
  const repo = yield* BenchJobRepo
  expect(yield* repo.scoreboard(c1)).toMatchObject([{ bestScore: 100 }])
}))

it.effect("findByUserId permits one membership per contest", () => Effect.gen(function* () {
  const repo = yield* TeamRepo
  expect(Option.isSome(yield* repo.findByUserId(c1, userId))).toBe(true)
  expect(Option.isSome(yield* repo.findByUserId(c2, userId))).toBe(true)
}))
```

Add domain/application cases proving rehearsal is accepted only for an admin in a preparing Contest, competition is accepted only in running, and rehearsal rows never contribute to scoreboard.

- [ ] **Step 2: Run repository tests and verify signature/query failures**

Run: `pnpm --filter portal exec vitest run test/infrastructure/repos.test.ts test/support/inMemoryPhase3Ports.test.ts`

Expected: FAIL until every repository and in-memory implementation accepts ContestId.

- [ ] **Step 3: Implement ContestRepo selection and optimistic writes**

`getDisplay` orders running/finalizing first, then preparing, then latest finished by edition. `getOperational` sees only preparing/running/finalizing. `saveIfRevision` uses one conditional `UPDATE` with `WHERE id=? AND revision=?` and `RETURNING`.

- [ ] **Step 4: Scope Team/Invite/Instance/BenchJob SQL atomically**

Update compound INSERT/UPDATE guards so contest ID is part of every membership, quota, active job, instance state, dequeue, timeout, and scoreboard predicate. `dequeueNextQueued` may select jobs only for the single running Contest and `purpose='competition'`, plus preparing rehearsal jobs.

- [ ] **Step 5: Consume all compatible pending invitations on login**

`auth.ts` obtains `InviteRepo.listByGithubLogin`, adds the user to each invite's contest-scoped Team, then deletes only the consumed `(contestId, githubLogin)` row. Reject invitation creation elsewhere if the login already has a different global Access email; do not silently remap identity email.

- [ ] **Step 6: Run repository, auth, provisioning and bench tests**

Run: `pnpm --filter portal exec vitest run test/infrastructure/migration0005.test.ts test/infrastructure/repos.test.ts test/support/inMemoryPhase3Ports.test.ts test/application/auth.test.ts test/application/invites.test.ts test/application/bench.test.ts test/application/provisioning.test.ts test/http && pnpm -r typecheck && pnpm -r test`

Expected: all selected tests PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add portal/src/infrastructure/sql/migrations/0005_multi_contest.ts portal/test/infrastructure/migration0005.test.ts portal/src/infrastructure/sql/seed.ts portal/test/infrastructure/seed.test.ts portal/src/domain/team.ts portal/src/domain/teamInvite.ts portal/src/domain/instance.ts portal/src/domain/benchJob.ts shared/src/schemas.ts portal/src/application/ports.ts portal/src/application/usecases/auth.ts portal/src/application/usecases/teams.ts portal/src/application/usecases/invites.ts portal/src/application/usecases/instances.ts portal/src/application/usecases/bench.ts portal/src/application/usecases/provisioning.ts portal/src/application/usecases/contest.ts portal/src/application/usecases/scoreboard.ts portal/src/infrastructure/http/handlers/auth.ts portal/src/infrastructure/http/handlers/teams.ts portal/src/infrastructure/http/handlers/instances.ts portal/src/infrastructure/http/handlers/bench.ts portal/src/infrastructure/http/handlers/runner.ts portal/src/infrastructure/http/handlers/admin.ts portal/src/infrastructure/http/handlers/contest.ts portal/src/infrastructure/http/handlers/scoreboard.ts portal/src/infrastructure/sql/repos/contestRepo.ts portal/src/infrastructure/sql/repos/teamRepo.ts portal/src/infrastructure/sql/repos/inviteRepo.ts portal/src/infrastructure/sql/repos/instanceRepo.ts portal/src/infrastructure/sql/repos/benchJobRepo.ts portal/test/infrastructure/repos.test.ts portal/test/support/inMemory.ts portal/test/support/inMemoryPhase3Ports.test.ts portal/test/support/apiTestHelpers.ts portal/test/application/auth.test.ts portal/test/application/invites.test.ts portal/test/application/bench.test.ts portal/test/application/provisioning.test.ts portal/test/http/auth.test.ts portal/test/http/teams.test.ts portal/test/http/instances.test.ts portal/test/http/invites.test.ts portal/test/http/bench.test.ts portal/test/http/contest.test.ts portal/test/http/scoreboard.test.ts
git commit --no-gpg-sign -m "feat(portal): scope repositories by contest"
```

---

### Task 4: Public contest archive and compatibility API

**Files:**
- Modify: `shared/src/api.ts`
- Modify: `shared/src/schemas.ts`
- Modify: `portal/src/application/usecases/contest.ts`
- Modify: `portal/src/application/usecases/scoreboard.ts`
- Modify: `portal/src/infrastructure/http/handlers/contest.ts`
- Modify: `portal/src/infrastructure/http/handlers/scoreboard.ts`
- Modify: `portal/web/src/api.ts`
- Modify: `portal/web/src/pages/Scoreboard.tsx`
- Modify: `portal/web/src/App.tsx`
- Test: `portal/test/http/contest.test.ts`
- Test: `portal/test/http/scoreboard.test.ts`

**Interfaces:**
- Consumes: Task 3 repositories.
- Produces public endpoints:

```text
GET /api/contests
GET /api/contests/:contestId
GET /api/contests/:contestId/scoreboard
GET /api/contest       # compatibility: ContestRepo.getDisplay
GET /api/scoreboard    # compatibility: getDisplay then contest-scoped scoreboard
```

`GET /api/contests` returns public metadata only and never Team member email, operation, or DB artifact information.

- [ ] **Step 1: Add failing public archive HTTP tests**

Create edition1 finished and edition2 running fixtures, assert list ordering, selected score isolation, unauthenticated 200, and compatibility routes resolving edition2.

```ts
const response = yield* client.contests.getContestScoreboard({ path: { contestId: edition1.id } })
expect(response.map((row) => row.bestScore)).toEqual([1077])
```

- [ ] **Step 2: Run HTTP tests and verify endpoint-not-found failures**

Run: `pnpm --filter portal exec vitest run test/http/contest.test.ts test/http/scoreboard.test.ts`

Expected: new endpoint calls FAIL before contract and handlers exist.

- [ ] **Step 3: Add contract, use cases, and handlers**

Keep existing endpoint names where possible; add a new `contests` HttpApiGroup for explicit-ID routes. Map `ContestNotFound` to the existing public 404. Scoreboard SQL must filter `purpose='competition'`.

- [ ] **Step 4: Add public edition selector**

`Scoreboard.tsx` loads `/api/contests`, selects the URL query `?contest=<id>` when valid, otherwise the first display-ordered contest, and then loads its scoreboard. Empty databases show「開催履歴はまだありません」without redirect loops.

- [ ] **Step 5: Run HTTP tests and Web build**

Run: `pnpm --filter portal exec vitest run test/http/contest.test.ts test/http/scoreboard.test.ts && pnpm --filter web typecheck && pnpm --filter web build`

Expected: tests PASS and Vite build succeeds.

- [ ] **Step 6: Commit Task 4**

```bash
git add shared/src/api.ts shared/src/schemas.ts portal/src/application/usecases/contest.ts portal/src/application/usecases/scoreboard.ts portal/src/infrastructure/http/handlers/contest.ts portal/src/infrastructure/http/handlers/scoreboard.ts portal/web/src/api.ts portal/web/src/pages/Scoreboard.tsx portal/web/src/App.tsx portal/test/http/contest.test.ts portal/test/http/scoreboard.test.ts
git commit --no-gpg-sign -m "feat(portal): expose contest archives"
```

---

### Task 5: Admin draft wizard and contest-scoped roster

**Files:**
- Modify: `shared/src/schemas.ts`
- Modify: `shared/src/api.ts`
- Create: `portal/src/application/usecases/contestAdmin.ts`
- Create: `portal/src/infrastructure/http/handlers/contestAdmin.ts`
- Create: `portal/web/src/pages/Contests.tsx`
- Create: `portal/web/src/pages/ContestSetup.tsx`
- Modify: `portal/src/application/usecases/teams.ts`
- Modify: `portal/src/application/usecases/invites.ts`
- Modify: `portal/src/infrastructure/http/handlers/teams.ts`
- Modify: `portal/src/infrastructure/http/handlers/admin.ts`
- Modify: `portal/web/src/pages/Admin.tsx`
- Modify: `portal/web/src/api.ts`
- Modify: `portal/web/src/App.tsx`
- Modify: `portal/web/src/index.css`
- Modify: `portal/web/package.json`
- Create: `portal/web/vitest.config.ts`
- Create: `portal/web/src/test/setup.ts`
- Create: `portal/web/src/pages/ContestSetup.test.tsx`
- Modify: `portal/src/main.ts`
- Test: `portal/test/application/contestAdmin.test.ts`
- Test: `portal/test/http/contestAdmin.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Task 3 contest-scoped repos and Task 4 contracts.
- Produces:

```ts
createContestDraft(input: {
  edition: number
  name: string
  problemKey: string
  problemRevision: string
  templateVmid: number
  instanceQuota: number
  scheduledStartAt: number | null
  scheduledEndAt: number | null
  accessClosesAt: number | null
  cleanupAt: number | null
}): Effect<Contest, RepoError | ContestEditionConflict | InvalidContestSchedule>

type ContestAdminError = RepoError | ContestNotFound | ContestRevisionConflict | OperationalContestConflict | InvalidContestTransition | InvalidContestSchedule
updateContestDraft(contestId: ContestId, expectedRevision: number, patch: DraftPatch): Effect<Contest, ContestAdminError>
copyContestRoster(sourceContestId: ContestId, targetContestId: ContestId): Effect<ReadonlyArray<Team>, ContestAdminError | TeamNumberConflict | MemberConflict>
beginContestPreparation(contestId: ContestId, expectedRevision: number, actorUserId: UserId): Effect<Contest, ContestAdminError>
cancelContest(contestId: ContestId, expectedRevision: number, actorUserId: UserId): Effect<Contest, ContestAdminError>
```

Admin endpoints use the `/api/admin/contests/:contestId` prefix for update, roster copy, begin-preparation, and cancel actions; existing non-ID team admin routes become compatibility wrappers around the operational draft/preparing Contest and are removed from the Web client.

- [ ] **Step 1: Write failing draft, revision, roster-copy, and transition tests**

Assert edition conflict 409, stale revision 409, desired count `0..quota`, copy creates new Team IDs, historical Team rows remain unchanged, and unsupported teamNumber outside prepared slots is not checked yet (readiness owns that later). Assert begin-preparation validates the complete schedule and the single-operational-Contest constraint, while cancel accepts only draft/preparing and leaves owned resources for the later cleanup flow.

- [ ] **Step 2: Run focused tests and verify missing-usecase failures**

Run: `pnpm --filter portal exec vitest run test/application/contestAdmin.test.ts test/http/contestAdmin.test.ts`

Expected: FAIL because admin use cases/routes are absent.

- [ ] **Step 3: Implement draft CRUD, roster copy, and explicit lifecycle transitions**

Use one transaction-owning repository method for copy so partial Teams/members cannot remain. New IDs come from UuidGen; pending invitations copy with the same normalized email but new contest/team IDs. The Admin API exposes revision-guarded begin-preparation and cancel actions; neither action performs provider mutation, and provider work remains a separately reviewed Operation.

- [ ] **Step 4: Implement the 5-step wizard**

The steps are Metadata, Schedule, Teams and members, Capacity, Review. Persist only on final submission. Default edition is `max(edition)+1`; default quota is3; no default actual dates. When the operator enters scheduledEndAt and leaves access close unchanged, set accessClosesAt to that same instant; cleanupAt remains null unless explicitly enabled. The review screen shows computed duration and desired total VM count.

- [ ] **Step 5: Add Web component test support and wizard tests**

Run `pnpm --filter web add -D vitest@^3.2.0 jsdom@^26.1.0 @testing-library/react@^16.3.0 @testing-library/user-event@^14.6.1 @testing-library/jest-dom@^6.6.3`. Add `"test": "vitest run"`, jsdom config, and a setup file importing `@testing-library/jest-dom/vitest`. Test validation and exact request body; do not snapshot the whole page.

```tsx
await user.type(screen.getByLabelText("開催回"), "2")
await user.click(screen.getByRole("button", { name: "確認へ" }))
expect(screen.getByText("合計 VM: 3台")).toBeInTheDocument()
```

- [ ] **Step 6: Run backend and Web tests**

Run: `pnpm --filter portal exec vitest run test/application/contestAdmin.test.ts test/http/contestAdmin.test.ts && pnpm --filter web test && pnpm --filter web build`

Expected: all focused tests and build PASS.

- [ ] **Step 7: Commit Task 5**

```bash
git add shared/src/schemas.ts shared/src/api.ts portal/src/application/usecases/contestAdmin.ts portal/src/application/usecases/teams.ts portal/src/application/usecases/invites.ts portal/src/infrastructure/http/handlers/contestAdmin.ts portal/src/infrastructure/http/handlers/teams.ts portal/src/infrastructure/http/handlers/admin.ts portal/src/main.ts portal/test/application/contestAdmin.test.ts portal/test/http/contestAdmin.test.ts portal/web/src/pages/Contests.tsx portal/web/src/pages/ContestSetup.tsx portal/web/src/pages/ContestSetup.test.tsx portal/web/src/pages/Admin.tsx portal/web/src/api.ts portal/web/src/App.tsx portal/web/src/index.css portal/web/src/test/setup.ts portal/web/vitest.config.ts portal/web/package.json pnpm-lock.yaml
git commit --no-gpg-sign -m "feat(admin): add contest setup wizard"
```

---

### Task 6: Durable Operation and resource ownership foundation

**Files:**
- Create: `portal/src/domain/operation.ts`
- Create: `portal/src/domain/resourceBinding.ts`
- Create: `portal/src/domain/artifact.ts`
- Create: `portal/src/infrastructure/sql/migrations/0006_operations.ts`
- Create: `portal/src/infrastructure/sql/repos/operationRepo.ts`
- Create: `portal/src/infrastructure/sql/repos/resourceBindingRepo.ts`
- Create: `portal/src/infrastructure/sql/repos/artifactRepo.ts`
- Create: `portal/src/infrastructure/sql/repos/runnerAgentRepo.ts`
- Create: `portal/src/application/usecases/operations.ts`
- Create: `portal/src/infrastructure/worker/operationWorker.ts`
- Modify: `portal/src/application/ports.ts`
- Modify: `portal/src/application/usecases/instances.ts`
- Modify: `portal/src/infrastructure/sql/repos/instanceRepo.ts`
- Modify: `portal/src/main.ts`
- Test: `portal/test/domain/operation.test.ts`
- Test: `portal/test/infrastructure/migration0006.test.ts`
- Test: `portal/test/infrastructure/operationRepo.test.ts`
- Test: `portal/test/worker/operationWorker.test.ts`
- Modify: `portal/test/application/provisioning.test.ts`
- Modify: `portal/test/infrastructure/repos.test.ts`

**Interfaces:**
- Consumes: Contest IDs and repository Layer conventions.
- Produces:

```ts
type OperationKind = "reconcile" | "enter_contest_mode" | "prepare" | "start" | "finish" | "revoke_access" | "cleanup" | "return_normal_mode" | "backup"
type OperationStatus = "queued" | "running" | "succeeded" | "failed" | "blocked" | "canceled"
type OperationStepStatus = "queued" | "running" | "succeeded" | "failed" | "blocked"
type OperationActor = { readonly kind: "admin"; readonly userId: UserId } | { readonly kind: "scheduler" }

OperationRepo.enqueue(input: NewOperation): Effect<Operation, RepoError | OperationInProgress>
OperationRepo.claimNext(now: number): Effect<Option<OperationStep>, RepoError>
OperationRepo.completeStep(stepId: OperationStepId, summary: string, now: number): Effect<void, RepoError>
OperationRepo.failStep(stepId: OperationStepId, error: SanitizedOperationError, retryAt: Option<number>, now: number): Effect<void, RepoError>
OperationRepo.resumeExpired(cutoff: number, now: number): Effect<number, RepoError>
OperationRepo.retry(operationId: OperationId, now: number): Effect<Operation, RepoError | InvalidOperationTransition>
OperationRepo.cancel(operationId: OperationId, now: number): Effect<Operation, RepoError | InvalidOperationTransition>

OperationHandler.run(step: OperationStep): Effect<StepOutcome, OperationExecutionError>
type StepOutcome = { readonly status: "succeeded"; readonly summary: string } | { readonly status: "retry"; readonly retryAt: number; readonly summary: string } | { readonly status: "blocked"; readonly summary: string }
```

Only one unfinished Operation is allowed globally by a partial unique index. `succeeded` and `canceled` release the lock; `failed` and `blocked` retain it until retry or explicit cancel. Each step has `continueOnError=false` by default; cleanup may mark independent resource steps true, allowing later steps to run while the Operation ultimately becomes failed if any such step exhausted retries. Operation enqueue atomically rejects any existing creating/deleting Instance. Self-service Instance create/delete atomically rejects any unfinished Operation. Internal Operation steps pass their own OperationId to `createIfAllowed`/`beginDeletingIfAllowed`, which permits only the matching active Operation.

- [ ] **Step 1: Write failing state-machine, migration, claim, and restart tests**

Assert one global unfinished Operation, atomic claim, ordered steps, no double claim, expired running step returns to queued, retryAt ordering, exponential retry deadlines with a maximum attempt count, completion after its last step, default failure stopping later steps, `continueOnError` allowing later independent steps but producing a failed Operation, failed/blocked retaining the lock, operator retry of only incomplete steps, safe cancel, enqueue rejection while an Instance is creating/deleting, self-service Instance rejection while an Operation is unfinished, matching-operation internal access, and sanitization that maps typed causes to an allowlisted code/summary without retaining bearer strings, request bodies, email addresses, or arbitrary provider messages.

- [ ] **Step 2: Run focused tests and verify missing modules**

Run: `pnpm --filter portal exec vitest run test/domain/operation.test.ts test/infrastructure/migration0006.test.ts test/infrastructure/operationRepo.test.ts test/worker/operationWorker.test.ts`

Expected: FAIL before the new domain, migration, repo, and worker exist.

- [ ] **Step 3: Implement operation tables and ownership tables**

The migration creates these explicit columns and constraints:

- `operations`: text PK `id`, required Contest FK, checked `kind`/`status`/`actor_kind`, nullable User FK `actor_user_id`, `plan_digest`, positive `contest_revision`, nullable `sanitized_error`, and `created_at`/`started_at`/`finished_at`. A CHECK requires a user ID only for admin actors.
- `operation_steps`: text PK `id`, cascading Operation FK, nonnegative unique `(operation_id, ordinal)`, unique `(operation_id, step_key)`, checked `status`, nonnegative `attempt`, checked boolean `continue_on_error` default0, nullable `retry_at` and `lease_expires_at`, required `input_summary`, `progress_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(progress_json))`, nullable `result_summary`/`sanitized_error`, and created/started/finished timestamps.
- `resource_bindings`: text PK, required Contest FK, nullable Team/Instance FKs, checked provider/resource type, canonical key, nullable external ID, required desired state, nullable last-observed state/time, and unique `(provider, resource_type, canonical_key)`.
- `contest_artifacts`: text PK, required Contest FK, checked kind, server storage path, SHA-256, nonnegative size, checked `off_host_status` in `not_applicable|pending|verified`, nullable verified time, created time, and unique `(contest_id, kind)`.
- `runner_agents`: runner ID PK, revision, checked boolean `bench_ready`, `health_summary` with `length <= 256`, and last-seen time.
- Partial unique index `idx_operations_single_unfinished` on constant `1` where status is not `succeeded|canceled`.

No table stores bearer tokens, raw request headers, or Access email arrays.

- [ ] **Step 4: Implement atomic repository transitions**

Use conditional updates with `RETURNING` for claim/complete/fail/retry/cancel. Cancel is rejected while a step is running. `OperationRepo.enqueue` and InstanceRepo guards include the cross-lock conditions in their mutation SQL so two concurrent requests cannot both pass. A worker restart never assumes the external mutation failed; handlers re-observe provider state in later tasks. Retryable failures use `min(OPERATION_RETRY_MAX_MILLIS, OPERATION_RETRY_BASE_MILLIS * 2 ** (attempt - 1))`, defaults 30000/1000, and move to failed after `OPERATION_MAX_ATTEMPTS` (default5); validation, authorization, conflict, and ambiguous outcomes move directly to blocked. `sanitizeOperationError` switches on known `_tag` values and emits fixed summaries plus non-secret canonical keys; unknown/provider causes become a fixed `external_operation_failed` summary and are logged only as redacted cause tags, never `String(cause)`.

- [ ] **Step 5: Implement OperationWorker registry and conditional Layer**

The initial registry may contain a test handler only. Wire the durable worker in every environment because DB-only start/finalize/archive Operations must not depend on Proxmox configuration; when a provider Layer is unavailable, readiness prevents provider Operations from being enqueued and an already-persisted provider step becomes blocked with a fixed configuration error. Tick interval comes from `OPERATION_POLL_INTERVAL_MILLIS`, default 1000; retry base/max/attempt settings are decoded once in the same Layer and passed as a typed worker config.

- [ ] **Step 6: Run focused tests and full typecheck**

Run: `pnpm --filter portal exec vitest run test/domain/operation.test.ts test/infrastructure/migration0006.test.ts test/infrastructure/operationRepo.test.ts test/worker/operationWorker.test.ts && pnpm -r typecheck`

Expected: tests and typechecks PASS.

- [ ] **Step 7: Commit Task 6**

```bash
git add portal/src/domain/operation.ts portal/src/domain/resourceBinding.ts portal/src/domain/artifact.ts portal/src/application/ports.ts portal/src/application/usecases/operations.ts portal/src/application/usecases/instances.ts portal/src/infrastructure/sql/migrations/0006_operations.ts portal/src/infrastructure/sql/repos/operationRepo.ts portal/src/infrastructure/sql/repos/resourceBindingRepo.ts portal/src/infrastructure/sql/repos/artifactRepo.ts portal/src/infrastructure/sql/repos/runnerAgentRepo.ts portal/src/infrastructure/sql/repos/instanceRepo.ts portal/src/infrastructure/worker/operationWorker.ts portal/src/main.ts portal/test/domain/operation.test.ts portal/test/infrastructure/migration0006.test.ts portal/test/infrastructure/operationRepo.test.ts portal/test/worker/operationWorker.test.ts portal/test/application/provisioning.test.ts portal/test/infrastructure/repos.test.ts
git commit --no-gpg-sign -m "feat(ops): add durable operation worker"
```

---

### Task 7: Provider inventory and reconciliation vertical slice

**Files:**
- Create: `portal/src/domain/reconciliation.ts`
- Create: `portal/src/application/usecases/reconciliation.ts`
- Create: `portal/src/infrastructure/http/handlers/operations.ts`
- Modify: `portal/src/application/ports.ts`
- Modify: `portal/src/infrastructure/proxmox/client.ts`
- Modify: `portal/src/infrastructure/cloudflare/client.ts`
- Modify: `portal/src/infrastructure/stubPorts.ts`
- Modify: `portal/src/main.ts`
- Modify: `shared/src/schemas.ts`
- Modify: `shared/src/api.ts`
- Test: `portal/test/domain/reconciliation.test.ts`
- Test: `portal/test/application/reconciliation.test.ts`
- Test: `portal/test/infrastructure/proxmox.test.ts`
- Test: `portal/test/infrastructure/cloudflare.test.ts`
- Test: `portal/test/http/operations.test.ts`

**Interfaces:**
- Consumes: Operation/ResourceBinding repos.
- Produces:

```ts
type ReconciliationClass = "in_sync" | "missing" | "drifted" | "managed_orphan" | "unmanaged_orphan" | "ambiguous"

ProxmoxPort.listManagedVms: Effect<ReadonlyArray<{ vmid: number; name: string; status: "running" | "stopped"; memoryBytes: number }>, ProxmoxError>
CloudflarePort.getInstanceInventory: Effect<{
  routes: ReadonlyArray<{ hostname: string; dnsRecordIds: ReadonlyArray<string>; ingressServices: ReadonlyArray<string> }>
  apps: ReadonlyArray<{ hostname: string; appIds: ReadonlyArray<string>; policyShape: "owned_exact" | "unknown"; emailSetHash: string }>
}, CloudflareError>

type ReconciliationError = RepoError | ContestNotFound | ProxmoxError | CloudflareError | AmbiguousReconciliation
planReconciliation(input: { contestId: ContestId; adoptHostnames: ReadonlyArray<string> }): Effect<ReconciliationPlan, ReconciliationError>
applyReconciliation(input: { contestId: ContestId; planDigest: string; contestRevision: number; actorUserId: UserId }): Effect<Operation, ReconciliationError | StaleReconciliationPlan | ContestRevisionConflict | OperationInProgress>
```

The API response exposes hostname, action, classification, counts, and sanitized reason; it never returns member email values.

- [ ] **Step 1: Write failing classification and legacy-state tests**

Use the observed 2026-08-13 shape: DB team1-1 running, no Proxmox team VM, Cloudflare team1-1/team2-1 present. Assert team1-1 is `missing + cleanup`, team2-1 is `unmanaged_orphan + blocked` until `adoptHostnames` contains it, and unrelated/catch-all records do not appear.

- [ ] **Step 2: Run focused tests and verify inventory methods are absent**

Run: `pnpm --filter portal exec vitest run test/domain/reconciliation.test.ts test/application/reconciliation.test.ts test/infrastructure/proxmox.test.ts test/infrastructure/cloudflare.test.ts`

Expected: FAIL on missing inventory and planner definitions.

- [ ] **Step 3: Implement sanitized provider inventories**

Proxmox filters exact `^inucon-team[0-9]+-[0-9]+$`. Cloudflare preserves duplicate IDs so the planner can classify duplicates as ambiguous. Access inventory calculates SHA-256 over sorted normalized emails in memory and discards the raw array before returning/logging.

- [ ] **Step 4: Implement canonical planning and digest**

Sort actions by `provider/resourceType/canonicalKey/action`, encode canonical JSON, and SHA-256 it. Apply recomputes inventory and rejects a stale digest or revision. Never accept arbitrary resource IDs from the browser.

- [ ] **Step 5: Implement reconciliation operation handlers**

Steps re-observe before mutation. After a provider timeout or transport interruption, return retry and inventory again before any mutation is resent; classify multiple or conflicting observed results as ambiguous/blocked. Missing VM + active DB Instance invokes the normal deletion state transition without calling a nonexistent VM destructive endpoint twice; routes/apps are removed idempotently; the Instance becomes deleted only after its owned bindings are absent. Adopt creates ResourceBinding rows for the exact observed hostname group, then uses the same cleanup path.

- [ ] **Step 6: Add admin plan/apply/detail/retry HTTP endpoints**

All endpoints use AdminOnly. `POST /api/admin/contests/:contestId/reconciliation/apply` requires `planDigest`, `contestRevision`, and explicit `adoptHostnames`; stale plan maps to409 and ambiguous plan maps to422.

- [ ] **Step 7: Run reconciliation and HTTP tests**

Run: `pnpm --filter portal exec vitest run test/domain/reconciliation.test.ts test/application/reconciliation.test.ts test/infrastructure/proxmox.test.ts test/infrastructure/cloudflare.test.ts test/http/operations.test.ts`

Expected: all selected tests PASS.

- [ ] **Step 8: Commit Task 7**

```bash
git add shared/src/schemas.ts shared/src/api.ts portal/src/domain/reconciliation.ts portal/src/application/ports.ts portal/src/application/usecases/reconciliation.ts portal/src/infrastructure/http/handlers/operations.ts portal/src/infrastructure/proxmox/client.ts portal/src/infrastructure/cloudflare/client.ts portal/src/infrastructure/stubPorts.ts portal/src/main.ts portal/test/domain/reconciliation.test.ts portal/test/application/reconciliation.test.ts portal/test/infrastructure/proxmox.test.ts portal/test/infrastructure/cloudflare.test.ts portal/test/http/operations.test.ts
git commit --no-gpg-sign -m "feat(ops): reconcile provider resources"
```

---

### Task 8: Infrastructure readiness and safe contest-mode operation

**Files:**
- Create: `portal/src/application/usecases/readiness.ts`
- Modify: `portal/src/application/usecases/operations.ts`
- Modify: `portal/src/application/usecases/contestAdmin.ts`
- Modify: `portal/src/application/ports.ts`
- Modify: `portal/src/infrastructure/proxmox/client.ts`
- Modify: `portal/src/infrastructure/http/handlers/operations.ts`
- Modify: `shared/src/schemas.ts`
- Modify: `shared/src/api.ts`
- Test: `portal/test/application/readiness.test.ts`
- Modify: `portal/test/application/contestAdmin.test.ts`
- Test: `portal/test/application/modeOperation.test.ts`
- Test: `portal/test/infrastructure/proxmox.test.ts`
- Test: `portal/test/http/operations.test.ts`

**Interfaces:**
- Consumes: Task 6 Operation worker and Task 7 inventory.
- Produces:

```ts
type ReadinessCheck = { key: string; status: "pass" | "warn" | "fail"; summary: string }

ProxmoxPort.getInfrastructureInventory: Effect<{
  nodeFreeMemBytes: number
  templateExists: boolean
  devvm: VmInventoryItem
  benchvm: VmInventoryItem
  preparedTeamNumbers: ReadonlyArray<number>
  isolationServiceActive: boolean
}, ProxmoxError>

ProxmoxPort.setVmOnBoot(vmid: number, enabled: boolean): Effect<void, ProxmoxError>
ProxmoxPort.shutdownVm(vmid: number): Effect<void, ProxmoxError>
ProxmoxPort.waitForVmStatus(vmid: number, status: "running" | "stopped", timeoutMillis: number): Effect<void, ProxmoxError | ModeTransitionTimeout>
CloudflarePort.probe: Effect<{ tokenStatus: "active"; inventoryReadable: true }, CloudflareError>
```

- [ ] **Step 1: Write failing readiness and mode tests**

Assert prior managed resource/active Instance blocks begin-preparation, unavailable DB, inactive or expired Cloudflare token, unreadable provider inventory, missing template, unsupported team3, inactive isolation service, insufficient memory to start benchvm plus host reserve after devvm shutdown, devvm shutdown timeout, and successful `set devvm onboot=0 -> shutdown -> wait -> memory check -> benchvm onboot=1 -> start` order. Add configuration tests for four split Proxmox fields, all-absent legacy fallback, and rejection of a partially configured split. A pre-switch sum of all dedicated VM RAM is an estimate/warning, not a hard failure, because linked-clone KSM recovery is observed between instance starts in Task9.

- [ ] **Step 2: Run tests and verify missing primitives**

Run: `pnpm --filter portal exec vitest run test/application/readiness.test.ts test/application/contestAdmin.test.ts test/application/modeOperation.test.ts test/infrastructure/proxmox.test.ts`

Expected: FAIL before readiness and power primitives exist.

- [ ] **Step 3: Implement Proxmox infrastructure inventory**

Split the client configuration into `PROXMOX_PROVISION_TOKEN_ID`/`PROXMOX_PROVISION_TOKEN_SECRET` for template/team VM calls and `PROXMOX_MODE_TOKEN_ID`/`PROXMOX_MODE_TOKEN_SECRET` for node audit plus VMIDs9200/9300 power/config calls; both share `PROXMOX_API_URL` and `PROXMOX_TLS_FINGERPRINT`. For a rolling migration only, if and only if all four split variables are absent, accept the existing `PROXMOX_TOKEN_ID`/`PROXMOX_TOKEN_SECRET` for both clients and emit one secret-free deprecation warning; partial split configuration is a startup error. This allows the new image to start before the agenix Secret switch, while final production uses only split credentials. Intersect node network interfaces named `teamN` with bridges present in benchvm VM config. Query `inucon-team-isolation` node service status. Obtain actual configured memory for devvm, benchvm and managed VMs; do not use the old 4GiB devvm assumption. The hard mode guard uses post-shutdown `MemAvailable >= benchvm configured memory + 1GiB host reserve`; desired team VM capacity is enforced incrementally in Task9.

- [ ] **Step 4: Implement readiness aggregation**

Readiness never mutates Contest or provider state; the backup adapter may create, fsync, and immediately remove a server-generated zero-byte canary beneath its own root. It returns stable keys such as `portal_db`, `previous_cleanup`, `template`, `team_slots`, `isolation`, `memory`, `capacity_estimate`, `benchvm`, `cloudflare_token`, `cloudflare_inventory`, `cloudflare_write_proven`, `runner`, `backup`, `rehearsal`. `CloudflarePort.probe` calls token verify and read inventories but does not grant the token API-Tokens-Read merely to introspect its own scopes; least-privilege permission issuance/rotation remains in the recovery runbook, while successful exact route/app convergence in Task 9 records `cloudflare_write_proven`. `capacity_estimate` warns when dedicated totals exceed the pre-switch estimate; per-instance observed memory remains authoritative. Checks not implemented until later tasks return warn rather than pass; start requires explicit pass for all required keys except `capacity_estimate`, because start occurs only after all desired Instances are already running. Upgrade `beginContestPreparation` so its final pre-save check requires `previous_cleanup=pass`, no unfinished Operation, and no creating/deleting Instance; draft creation/editing remains available while cleanup is incomplete.

- [ ] **Step 5: Implement enter-contest-mode steps**

Use a 60-second graceful timeout, never call force stop, and re-observe status before every step. If devvm is already stopped or benchvm already running, the corresponding step succeeds idempotently. A timeout returns blocked with the exact recovery command but does not run it.

- [ ] **Step 6: Run focused tests and HTTP readiness test**

Run: `pnpm --filter portal exec vitest run test/application/readiness.test.ts test/application/contestAdmin.test.ts test/application/modeOperation.test.ts test/infrastructure/proxmox.test.ts test/http/operations.test.ts`

Expected: tests PASS.

- [ ] **Step 7: Commit Task 8**

```bash
git add shared/src/schemas.ts shared/src/api.ts portal/src/application/ports.ts portal/src/application/usecases/readiness.ts portal/src/application/usecases/operations.ts portal/src/application/usecases/contestAdmin.ts portal/src/infrastructure/proxmox/client.ts portal/src/infrastructure/http/handlers/operations.ts portal/test/application/readiness.test.ts portal/test/application/contestAdmin.test.ts portal/test/application/modeOperation.test.ts portal/test/infrastructure/proxmox.test.ts portal/test/http/operations.test.ts
git commit --no-gpg-sign -m "feat(ops): add safe contest mode switching"
```

---

### Task 9: Batch preparation, exact Access policy, and bindings

**Files:**
- Modify: `portal/src/application/usecases/provisioning.ts`
- Modify: `portal/src/application/usecases/operations.ts`
- Modify: `portal/src/application/usecases/readiness.ts`
- Modify: `portal/src/application/ports.ts`
- Modify: `portal/src/infrastructure/cloudflare/client.ts`
- Modify: `portal/src/infrastructure/worker/provisioner.ts`
- Modify: `portal/src/infrastructure/sql/repos/resourceBindingRepo.ts`
- Modify: `portal/src/main.ts`
- Test: `portal/test/application/provisioning.test.ts`
- Test: `portal/test/application/prepareOperation.test.ts`
- Test: `portal/test/infrastructure/cloudflare.test.ts`
- Test: `portal/test/worker/provisioner.test.ts`

**Interfaces:**
- Consumes: contest-scoped Instance, ResourceBinding, readiness, Operation worker.
- Produces:

```ts
CloudflarePort.ensureAccessAppExact(args: { hostname: string; emails: ReadonlyArray<string> }): Effect<{ appId: string; policyId: string }, CloudflareError | AmbiguousAccessPolicy>
CloudflarePort.ensureInstanceRoute(args: { hostname: string; ip: string }): Effect<{ dnsRecordId: string }, CloudflareError>

type PrepareContestError = RepoError | ContestNotFound | InvalidContestTransition | StaleReconciliationPlan | ContestRevisionConflict | OperationInProgress | AmbiguousAccessPolicy
prepareContest(contestId: ContestId, actorUserId: UserId, planDigest: string, contestRevision: number): Effect<Operation, PrepareContestError>
```

- [ ] **Step 1: Replace union-policy expectations with failing exact-policy tests**

Assert old email removal, normalized sorted deduplication, no raw emails in errors, unknown extra policy blocks, and returned external IDs are bound to contest/team/instance.

- [ ] **Step 2: Add failing batch convergence tests**

For desired count3 and actual count1, assert the operation requests one Instance at a time, waits until running, then rechecks free memory before requesting the next. Cover a low/low/high memory sequence to prove KSM settling is retried, and a permanently-low sequence to prove the step blocks only after the settle deadline. The blocked result keeps two running instances intact and has no third creating row.

- [ ] **Step 3: Run focused tests and verify existing union behavior fails**

Run: `pnpm --filter portal exec vitest run test/infrastructure/cloudflare.test.ts test/application/provisioning.test.ts test/application/prepareOperation.test.ts`

Expected: exact-policy and batch tests FAIL against current behavior.

- [ ] **Step 4: Implement exact policy and ResourceBinding persistence**

Only portal-created app/policy shapes may be replaced. Persist VM binding after clone observation, DNS binding after DNS success, ingress binding after config observation, and app/policy bindings after exact policy success. A crash between provider success and binding write is recovered by inventory and canonical key.

- [ ] **Step 5: Implement nonblocking batch convergence**

The Operation step re-reads the Contest first and blocks without new provider mutation if it is no longer preparing; this matters when scheduled finalization/cancel races a long prepare. It returns retry with `retryAt = now + 2000` while an Instance is creating/deleting. Every clone request sets `pool=inucon-team-vms`, matching the least-privilege ACL prepared in Task 14. After an Instance becomes running, require the configured `PVE_MIN_FREE_BYTES` before enqueuing the next. If memory is below the threshold, persist the first low-memory observation in step progress and retry every `KSM_POLL_MILLIS` (default 10000) until `KSM_SETTLE_TIMEOUT_MILLIS` (default 600000). Clear the observation when memory recovers; after the deadline, mark the step blocked without creating another Instance. Wire both values through `portal/src/main.ts`. Do not hold an Effect sleep inside the global worker.

- [ ] **Step 6: Run provisioning, Cloudflare, and worker tests**

Run: `pnpm --filter portal exec vitest run test/infrastructure/cloudflare.test.ts test/application/provisioning.test.ts test/application/prepareOperation.test.ts test/worker/provisioner.test.ts`

Expected: tests PASS.

- [ ] **Step 7: Commit Task 9**

```bash
git add portal/src/application/ports.ts portal/src/application/usecases/provisioning.ts portal/src/application/usecases/operations.ts portal/src/application/usecases/readiness.ts portal/src/infrastructure/cloudflare/client.ts portal/src/infrastructure/worker/provisioner.ts portal/src/infrastructure/sql/repos/resourceBindingRepo.ts portal/src/main.ts portal/test/application/provisioning.test.ts portal/test/application/prepareOperation.test.ts portal/test/infrastructure/cloudflare.test.ts portal/test/worker/provisioner.test.ts
git commit --no-gpg-sign -m "feat(ops): converge contest instances and access"
```

---

### Task 10: Runner heartbeat, rehearsal, and guarded start

**Files:**
- Modify: `shared/src/schemas.ts`
- Modify: `shared/src/api.ts`
- Modify: `runner/src/loop.ts`
- Modify: `runner/src/main.ts`
- Modify: `portal/src/application/usecases/bench.ts`
- Modify: `portal/src/application/usecases/readiness.ts`
- Modify: `portal/src/application/usecases/contestAdmin.ts`
- Modify: `portal/src/application/ports.ts`
- Create: `portal/src/infrastructure/backup/sqlite.ts`
- Modify: `portal/src/infrastructure/sql/repos/runnerAgentRepo.ts`
- Modify: `portal/src/infrastructure/sql/repos/benchJobRepo.ts`
- Modify: `portal/src/infrastructure/http/handlers/runner.ts`
- Modify: `portal/src/infrastructure/http/handlers/operations.ts`
- Modify: `portal/src/main.ts`
- Modify: `portal/package.json`
- Modify: `pnpm-lock.yaml`
- Test: `runner/test/loop.test.ts`
- Test: `portal/test/application/bench.test.ts`
- Test: `portal/test/application/readiness.test.ts`
- Test: `portal/test/infrastructure/backupProbe.test.ts`
- Test: `portal/test/http/bench.test.ts`
- Test: `portal/test/http/operations.test.ts`

**Interfaces:**
- Consumes: Task 3 job purpose, Task 8 readiness, Task 9 prepared Instances.
- Produces poll payload and start gate:

```ts
type RunnerPollRequest = { runnerId: string; revision: string; benchReady: boolean; healthSummary: string }
RunnerAgentRepo.touch(runnerId: string, revision: string, benchReady: boolean, healthSummary: string, now: number): Effect<void, RepoError>
RunnerAgentRepo.getFresh(now: number, maxAgeMillis: number): Effect<Option<RunnerAgent>, RepoError>
BackupPort.probe: Effect<void, BackupError>

type RehearsalError = RepoError | Forbidden | ContestNotFound | InstanceNotFound | InstanceNotRunning | ContestNotPreparing | TeamJobAlreadyQueued
enqueueRehearsal(contestId: ContestId, instanceId: InstanceId, actor: User): Effect<BenchJob, RehearsalError>
requestContestStart(contestId: ContestId, expectedRevision: number, actorUserId: UserId): Effect<Operation, OperationInProgress | ContestNotFound | ContestRevisionConflict | RepoError>
```

- [ ] **Step 1: Write failing heartbeat and rehearsal tests**

Assert every poll updates lastSeenAt/revision/bench health, stale heartbeat and `benchReady=false` fail readiness, healthSummary is bounded and sanitized, rehearsal works only for admin/preparing/running Instance, competition still requires running, and rehearsal scores never enter scoreboard.

- [ ] **Step 2: Write failing start-gate tests**

Table-drive missing cleanup, non-running desired instance, drift, stale/unhealthy runner, no successful rehearsal, unavailable backup, `scheduledEndAt <= now`, and valid all-pass transition. Add adapter tests proving probe succeeds only when the configured backup root exists, is a directory, is writable by the process, and a create/fsync/delete canary completes beneath the canonical root.

- [ ] **Step 3: Run focused tests and verify failures**

Run: `pnpm --filter runner exec vitest run test/loop.test.ts && pnpm --filter portal exec vitest run test/application/bench.test.ts test/application/readiness.test.ts test/infrastructure/backupProbe.test.ts test/http/bench.test.ts test/http/operations.test.ts`

Expected: new cases FAIL before heartbeat/rehearsal/start gate exist.

- [ ] **Step 4: Implement heartbeat propagation**

Runner requires `RUNNER_ID` default `benchvm` and `RUNNER_REVISION` with no empty production default. Dev may use `dev`. Before every poll it verifies that `BENCH_DIR` exists and that the configured adapter executable/input files are readable, then sends a bounded non-secret health code/summary. Portal touches heartbeat before polling a job; heartbeat failure prevents dequeue rather than silently running untracked. A successful poll itself proves runner-to-portal reachability. Replace raw HTTP `Cause` logging in report/poll retries with fixed operation names and status/error tags so the request object and bearer header cannot reach journald.

- [ ] **Step 5: Implement rehearsal and scoreboard filtering**

The same runner protocol executes both purposes. Poll order prefers running Contest competition; otherwise preparing rehearsal. Each job carries contestId and purpose to the runner response and finish path.

- [ ] **Step 6: Implement start Operation with fresh readiness recomputation**

Do not trust the last UI readiness response. POST start enqueues an audited `start` Operation carrying the expected Contest revision; its single step recomputes every required check immediately before `saveIfRevision`. Run `pnpm --filter portal add better-sqlite3@12.11.1 && pnpm --filter portal add -D @types/better-sqlite3@7.6.13` (matching the native version already resolved for `@effect/sql-sqlite-node`) and implement the initial `BackupPortLive.probe` using canonical `BACKUP_PATH`; Task 11 extends the same adapter with snapshot creation. Map a blocked ReadinessFailed step to an Operation detail containing failing check keys only, never provider responses or email values. HTTP returns202 with the Operation and the Web polls it like every other mutation.

- [ ] **Step 7: Run runner, application, HTTP, and scoreboard tests**

Run: `pnpm --filter runner test && pnpm --filter portal exec vitest run test/application/bench.test.ts test/application/readiness.test.ts test/infrastructure/backupProbe.test.ts test/http/bench.test.ts test/http/operations.test.ts test/http/scoreboard.test.ts`

Expected: tests PASS.

- [ ] **Step 8: Commit Task 10**

```bash
git add shared/src/schemas.ts shared/src/api.ts runner/src/loop.ts runner/src/main.ts runner/test/loop.test.ts portal/src/application/ports.ts portal/src/application/usecases/bench.ts portal/src/application/usecases/readiness.ts portal/src/application/usecases/contestAdmin.ts portal/src/infrastructure/backup/sqlite.ts portal/src/infrastructure/sql/repos/runnerAgentRepo.ts portal/src/infrastructure/sql/repos/benchJobRepo.ts portal/src/infrastructure/http/handlers/runner.ts portal/src/infrastructure/http/handlers/operations.ts portal/src/main.ts portal/package.json pnpm-lock.yaml portal/test/application/bench.test.ts portal/test/application/readiness.test.ts portal/test/infrastructure/backupProbe.test.ts portal/test/http/bench.test.ts portal/test/http/operations.test.ts
git commit --no-gpg-sign -m "feat(contest): add rehearsal and guarded start"
```

---

### Task 11: Scheduled finalization and archive artifacts

**Files:**
- Create: `portal/src/application/usecases/finalization.ts`
- Create: `portal/src/application/usecases/archives.ts`
- Create: `portal/src/cli/backup.ts`
- Modify: `portal/src/infrastructure/backup/sqlite.ts`
- Create: `portal/src/infrastructure/worker/contestScheduler.ts`
- Create: `deploy/k8s/backup-pvc.yaml`
- Modify: `portal/src/application/ports.ts`
- Modify: `portal/src/application/usecases/contest.ts`
- Modify: `portal/src/infrastructure/sql/repos/benchJobRepo.ts`
- Modify: `portal/src/infrastructure/sql/repos/artifactRepo.ts`
- Modify: `portal/src/infrastructure/http/handlers/contest.ts`
- Modify: `portal/src/main.ts`
- Modify: `deploy/k8s/deployment.yaml`
- Modify: `shared/src/schemas.ts`
- Modify: `shared/src/api.ts`
- Test: `portal/test/application/finalization.test.ts`
- Test: `portal/test/application/archives.test.ts`
- Test: `portal/test/infrastructure/sqliteBackup.test.ts`
- Test: `portal/test/worker/contestScheduler.test.ts`
- Test: `portal/test/http/artifacts.test.ts`

**Interfaces:**
- Consumes: lifecycle, Operation worker, contest-scoped scoreboard.
- Produces:

```ts
BenchJobRepo.cancelQueuedByContest(contestId: ContestId, now: number): Effect<number, RepoError>
BenchJobRepo.countRunningByContest(contestId: ContestId): Effect<number, RepoError>

BackupPort.createSnapshot(args: { contestId: ContestId; edition: number; now: number }): Effect<{ storagePath: string; sha256: string; sizeBytes: number }, BackupError>

ArtifactRepo.create(artifact: ContestArtifact): Effect<void, RepoError>
ArtifactRepo.listByContest(contestId: ContestId): Effect<ReadonlyArray<ContestArtifact>, RepoError>
ArtifactRepo.findById(id: ArtifactId): Effect<Option<ContestArtifact>, RepoError>
ArtifactRepo.markOffHostVerified(id: ArtifactId, expectedSha256: string, now: number): Effect<ContestArtifact, RepoError | ArtifactChecksumMismatch>

requestLegacyArchive(contestId: ContestId, actorUserId: UserId): Effect<Operation, OperationInProgress | InvalidArchiveState | ContestNotFound | RepoError>
```

- [ ] **Step 1: Write failing TestClock scheduler tests**

Create a running contest due at1000, advance TestClock, assert exactly one finalizing transition and operation. Restart the scheduler Layer and assert no duplicate. Add manual immediate finish using the same operation path.

- [ ] **Step 2: Write failing drain and artifact tests**

Assert queued cancellation, running wait, timeout completion, competition-only JSON/CSV, stable CSV column order, SHA-256, DB snapshot metadata with `offHostStatus=pending`, checksum-guarded off-host verification, and no finished transition before all required artifacts exist. Also assert an already-finished legacy Contest can idempotently generate only its missing archive artifacts without changing status, jobs, or scores.

- [ ] **Step 3: Run focused tests and verify missing modules**

Run: `pnpm --filter portal exec vitest run test/application/finalization.test.ts test/application/archives.test.ts test/infrastructure/sqliteBackup.test.ts test/worker/contestScheduler.test.ts test/http/artifacts.test.ts`

Expected: FAIL before finalizer, scheduler, snapshot method/CLI, and endpoints exist.

- [ ] **Step 4: Implement finalization steps**

The scheduler/manual request first performs a revision-guarded `running -> finalizing` transition even when another global Operation currently owns the lock, so new competition enqueue stops at the deadline. It then keeps attempting to enqueue exactly one finish Operation after the lock is released. Its steps are `cancel_queued`, `wait_running`, `write_scoreboard_json`, `write_scoreboard_csv`, `write_db_snapshot`, `finish_contest`. `wait_running` returns retry until count zero; existing timeout sweeper remains authoritative for stuck jobs. A separate `backup` Operation for an already-finished Contest runs only the three idempotent artifact steps and supports edition1 closeout.

- [ ] **Step 5: Implement secure backup and artifact download**

Extend Task 10's direct `better-sqlite3` adapter. Resolve every output beneath configured `/backups`; filenames are server-generated. Use database `.backup()` and calculate SHA-256 after close. Add a non-server `portal/dist/cli/backup.js` entrypoint taking explicit `--source` and `--destination` paths, refusing an existing destination or same source/destination, and printing only JSON metadata; it imports no migrator/main Layer and exists for the pre-migration Kubernetes Job in Task15. DB snapshot download is AdminOnly with `Cache-Control: no-store`; scoreboard JSON/CSV may be public. Handler resolves path only from ArtifactRepo, never a request path. An AdminOnly confirmation endpoint accepts the displayed SHA-256 and marks a downloaded DB snapshot `verified`; a mismatch is409 and neither this flag nor a browser download is treated as an automatic off-host copy.

- [ ] **Step 6: Add backup PVC and readiness probe**

Mount `inucon-portal-backups` at `/backups`, set `BACKUP_PATH=/backups`, and add `BackupPort.probe` to readiness. Keep the primary DB PVC unchanged.

- [ ] **Step 7: Run finalizer tests, full test suite, and Docker build**

Run: `pnpm --filter portal exec vitest run test/application/finalization.test.ts test/application/archives.test.ts test/infrastructure/sqliteBackup.test.ts test/worker/contestScheduler.test.ts test/http/artifacts.test.ts && pnpm -r test && docker build -f deploy/Dockerfile -t inucon-portal:contest-automation .`

Expected: tests PASS and image build succeeds.

- [ ] **Step 8: Commit Task 11**

```bash
git add shared/src/schemas.ts shared/src/api.ts portal/src/application/ports.ts portal/src/application/usecases/contest.ts portal/src/application/usecases/finalization.ts portal/src/application/usecases/archives.ts portal/src/cli/backup.ts portal/src/infrastructure/backup/sqlite.ts portal/src/infrastructure/worker/contestScheduler.ts portal/src/infrastructure/sql/repos/benchJobRepo.ts portal/src/infrastructure/sql/repos/artifactRepo.ts portal/src/infrastructure/http/handlers/contest.ts portal/src/main.ts portal/test/application/finalization.test.ts portal/test/application/archives.test.ts portal/test/infrastructure/sqliteBackup.test.ts portal/test/worker/contestScheduler.test.ts portal/test/http/artifacts.test.ts deploy/k8s/backup-pvc.yaml deploy/k8s/deployment.yaml
git commit --no-gpg-sign -m "feat(contest): finalize schedules and archive results"
```

---

### Task 12: Access close, cleanup, and normal-mode return

**Files:**
- Create: `portal/src/application/usecases/cleanup.ts`
- Modify: `portal/src/application/usecases/finalization.ts`
- Modify: `portal/src/application/usecases/operations.ts`
- Modify: `portal/src/application/usecases/reconciliation.ts`
- Modify: `portal/src/infrastructure/worker/contestScheduler.ts`
- Modify: `portal/src/infrastructure/http/handlers/operations.ts`
- Test: `portal/test/application/cleanup.test.ts`
- Test: `portal/test/worker/contestScheduler.test.ts`
- Test: `portal/test/http/operations.test.ts`

**Interfaces:**
- Consumes: exact Cloudflare removal, Instance deletion saga, reconciliation, mode primitives.
- Produces:

```ts
type CleanupRequestError = RepoError | ContestNotFound | ContestRevisionConflict | StaleReconciliationPlan | OperationInProgress
closeContestAccess(contestId: ContestId, actor: OperationActor): Effect<Operation, CleanupRequestError>
cleanupContestResources(contestId: ContestId, planDigest: string, contestRevision: number, actorUserId: UserId): Effect<Operation, CleanupRequestError>
returnNormalMode(contestId: ContestId, actorUserId: UserId): Effect<Operation, CleanupRequestError | ResidualManagedResource>
```

- [ ] **Step 1: Write failing access-close and cleanup tests**

Assert accessClosesAt scheduling, idempotent route/app removal, VM cleanup one at a time, partial cleanup continues to the next independent resource, final reconciliation requirement, benchvm shutdown only after zero managed VMs, and devvm start only after memory guard.

- [ ] **Step 2: Run focused tests and verify missing orchestration**

Run: `pnpm --filter portal exec vitest run test/application/cleanup.test.ts test/worker/contestScheduler.test.ts test/http/operations.test.ts`

Expected: FAIL on missing cleanup operations.

- [ ] **Step 3: Implement scheduled access close**

Scheduler enqueues `revoke_access` when accessClosesAt is due, independent of Contest already being finished. It records terminal ResourceBinding absence and does not delete VM yet.

- [ ] **Step 4: Implement explicit and opt-in scheduled cleanup**

Default cleanupAt is null. Explicit admin apply or non-null due cleanupAt creates one cleanup Operation. Each retry observes Instance/provider state. Generate deterministic per-hostname resource steps with `continueOnError=true`; a failed resource is sanitized/summarized and remaining independent hostnames continue. The Operation ends failed after all runnable cleanup steps until reconciliation is clean and the operator retries only failed/incomplete steps.

- [ ] **Step 5: Implement normal-mode return**

Steps are `verify_no_managed_vms`, `set_benchvm_onboot_0`, `shutdown_benchvm`, `wait_benchvm_stopped`, `memory_check`, `set_devvm_onboot_1`, `start_devvm`, `verify_devvm_running`. Any residual VM/resource blocks the first step.

- [ ] **Step 6: Run cleanup tests and lifecycle regression suite**

Run: `pnpm --filter portal exec vitest run test/application/cleanup.test.ts test/application/finalization.test.ts test/application/reconciliation.test.ts test/application/modeOperation.test.ts test/worker/contestScheduler.test.ts test/http/operations.test.ts`

Expected: tests PASS.

- [ ] **Step 7: Commit Task 12**

```bash
git add portal/src/application/usecases/cleanup.ts portal/src/application/usecases/finalization.ts portal/src/application/usecases/operations.ts portal/src/application/usecases/reconciliation.ts portal/src/infrastructure/worker/contestScheduler.ts portal/src/infrastructure/http/handlers/operations.ts portal/test/application/cleanup.test.ts portal/test/worker/contestScheduler.test.ts portal/test/http/operations.test.ts
git commit --no-gpg-sign -m "feat(ops): automate contest resource closeout"
```

---

### Task 13: Admin lifecycle, reconciliation, operation, and archive UI

**Files:**
- Create: `portal/web/src/pages/ContestAdmin.tsx`
- Create: `portal/web/src/pages/OperationDetail.tsx`
- Create: `portal/web/src/pages/contestViewModel.ts`
- Create: `portal/web/src/pages/contestViewModel.test.ts`
- Create: `portal/web/src/pages/ContestAdmin.test.tsx`
- Modify: `portal/web/src/pages/Contests.tsx`
- Modify: `portal/web/src/pages/Admin.tsx`
- Modify: `portal/web/src/pages/Team.tsx`
- Modify: `portal/web/src/api.ts`
- Modify: `portal/web/src/App.tsx`
- Modify: `portal/web/src/index.css`

**Interfaces:**
- Consumes: all backend endpoints from Tasks 5-12.
- Produces routes:

```text
/admin/contests
/admin/contests/new
/admin/contests/:contestId
/admin/operations/:operationId
/scoreboard?contest=:contestId
```

ContestAdmin tabs are Overview, Teams, Readiness, Reconciliation, Operations, Archive.

- [ ] **Step 1: Write failing pure view-model and component tests**

Test status labels/action enablement, failing readiness grouping, unmanaged orphan requiring checkbox, exact plan digest submission, no credential fields, stale-plan error refresh, and operation polling stop on terminal status.

- [ ] **Step 2: Run Web tests and verify missing pages/helpers**

Run: `pnpm --filter web test`

Expected: FAIL before new components exist.

- [ ] **Step 3: Implement API wrappers and pure view model**

Every mutation wrapper requires explicit IDs/revision/digest. Map typed409 stale response to「状態が変わりました。再診断してください」and typed422 ambiguous/readiness response to its check keys.

- [ ] **Step 4: Implement ContestAdmin tabs**

Overview holds lifecycle actions and schedule; Teams holds desired/actual instances and roster; Readiness is read-only refresh; Reconciliation shows provider/resource/action/classification; Operations links durable logs; Archive lists kind/size/checksum/download/off-host status and lets an admin confirm an off-host DB copy by re-entering the displayed checksum.

- [ ] **Step 5: Implement dangerous-action confirmation**

For mode switch, start, immediate finish, adopt/delete, cleanup, and normal return, show exact affected hostnames/VMIDs and require a confirmation checkbox. No free-form confirmation string is sent to backend; backend authorization/digest remains authoritative.

- [ ] **Step 6: Update Team page to operational contest**

Team page displays the Contest edition and purpose-aware bench controls. During preparing, members cannot run rehearsal; admin action lives in ContestAdmin. During finalizing/finished, enqueue controls are disabled with the lifecycle reason.

- [ ] **Step 7: Run Web tests/build and portal HTTP suite**

Run: `pnpm --filter web test && pnpm --filter web build && pnpm --filter portal exec vitest run test/http`

Expected: Web tests/build and all HTTP tests PASS.

- [ ] **Step 8: Commit Task 13**

```bash
git add portal/web/src/pages/ContestAdmin.tsx portal/web/src/pages/OperationDetail.tsx portal/web/src/pages/contestViewModel.ts portal/web/src/pages/contestViewModel.test.ts portal/web/src/pages/ContestAdmin.test.tsx portal/web/src/pages/Contests.tsx portal/web/src/pages/Admin.tsx portal/web/src/pages/Team.tsx portal/web/src/api.ts portal/web/src/App.tsx portal/web/src/index.css
git commit --no-gpg-sign -m "feat(web): add contest operations console"
```

---

### Task 14: agenix source of truth in nixos-config-private

**Repository:** `../nixos-config-private`

**Files:**
- Create: `secrets/inucon-portal-env.age`
- Create: `secrets/inucon-proxmox-provision.age`
- Create: `secrets/inucon-proxmox-mode.age`
- Create: `secrets/runner-env.age`
- Create: `secrets/inucon-tunnel-token.age`
- Create: `scripts/provision-inucon-proxmox-credentials.sh`
- Modify: `secrets/secrets.nix`
- Modify: `hosts/apphost/configuration.nix`
- Modify: `hosts/benchvm/configuration.nix`
- Create: `tests/inucon-secrets.nix`
- Modify: `flake.nix`
- Modify: `docs/runbooks/apphost-cloudflared.md`

**Interfaces:**
- Consumes: existing live k3s Secret, Cloudflare API token, account/tunnel IDs, agenix recipients.
- Produces age secrets with these exact EnvironmentFile keys:

```text
inucon-portal-env.age: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, ADMIN_GITHUB_LOGINS, RUNNER_TOKEN, BASE_URL, PROXMOX_API_URL, PROXMOX_TLS_FINGERPRINT, CF_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID, CF_TUNNEL_ID, RUNNER_MAX_AGE_MILLIS
inucon-proxmox-provision.age: PROXMOX_PROVISION_TOKEN_ID, PROXMOX_PROVISION_TOKEN_SECRET
inucon-proxmox-mode.age: PROXMOX_MODE_TOKEN_ID, PROXMOX_MODE_TOKEN_SECRET
runner-env.age: PORTAL_URL, RUNNER_TOKEN, BENCH_DIR, RUNNER_ID
inucon-tunnel-token.age: TUNNEL_TOKEN
```

- [ ] **Step 1: Create a clean sibling-repo branch and preserve user files**

Run from `../nixos-config-private`:

```bash
git status --short --branch
git switch -c feat/inucon-contest-automation-secrets
```

Do not add existing untracked `.nvimlog` or `tmp/`.

- [ ] **Step 2: Register recipients and write failing Nix assertions**

Add recipient rules: portal and both Proxmox envs use apphost-host, apphost-kise, macOS, desktop, and Redmi keys; runner/tunnel env use benchvm-host, macOS, desktop, and Redmi keys. `tests/inucon-secrets.nix` evaluates that apphost has an age-backed portal env sync service after k3s, benchvm services use age paths rather than `/root/.inucon-tunnel-env` and `/home/kise/.inucon/runner-env`, file owners are correct, and no secret value appears in generated unit text.

- [ ] **Step 3: Run the new check and verify assertion failure**

Run: `nix flake check --no-build`

Expected: FAIL because the secret declarations/services do not exist.

- [ ] **Step 4: Encrypt the existing portal env without plaintext output or disk**

Use recipient public keys from `secrets.nix`. Run from the sibling repository root; this helper evaluates only public recipient keys and passes stdin directly to age:

```bash
set -euo pipefail
encrypt_age_rule() {
  local rule=$1 output=$2 recipient
  local -a recipients=() age_args=()
  mapfile -t recipients < <(
    nix eval --json --expr 'import ./secrets/secrets.nix' |
      jq -r --arg rule "$rule" '.[$rule].publicKeys[]'
  )
  ((${#recipients[@]} > 0))
  for recipient in "${recipients[@]}"; do
    age_args+=(-r "$recipient")
  done
  age -a "${age_args[@]}" -o "$output"
}

{
  ssh -o BatchMode=yes apphost.kisen.one \
    'kubectl -n inucon get secret inucon-portal-env -o json' |
    jq -er '
      ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "ADMIN_GITHUB_LOGINS", "RUNNER_TOKEN", "BASE_URL", "PROXMOX_API_URL", "PROXMOX_TLS_FINGERPRINT", "CF_API_TOKEN", "CF_ACCOUNT_ID", "CF_ZONE_ID", "CF_TUNNEL_ID"] as $required |
      .data as $data |
      ($required - ($data | keys)) as $missing |
      if ($missing | length) != 0 then error("required portal keys are missing")
      else $required[] as $key | "\($key)=\($data[$key] | @base64d)"
      end
    '
  printf 'RUNNER_MAX_AGE_MILLIS=15000\n'
} | encrypt_age_rule inucon-portal-env.age secrets/inucon-portal-env.age
```

Do not use `set -x`, command substitution containing decoded values, terminal printing, or a plaintext tempfile. On any pipeline failure, delete only the newly created incomplete ciphertext and retry from the live Secret.

- [ ] **Step 5: Implement a plan-first Proxmox credential bootstrap and stop before apply**

Create `scripts/provision-inucon-proxmox-credentials.sh` with read-only default/`--plan` and explicit `--apply --token-suffix <new-unique-suffix>`. The plan validates eevee `192.0.2.10`, VMIDs9100/9200/9300 and their names, storage `local-lvm`, the absence of target token IDs, and prints only role/user/pool/ACL names. Run plan during implementation, then stop for explicit user approval immediately before apply. It idempotently creates pool `inucon-team-vms` containing template9100, dedicated no-password users `inucon-provision@pve` and `inucon-mode@pve`, and these least-privilege roles/ACLs:

```text
InuconProvisionVm on /pool/inucon-team-vms:
  VM.Allocate, VM.Audit, VM.Clone, VM.Config.Cloudinit, VM.Config.Disk,
  VM.Config.Network, VM.Config.Options, VM.GuestAgent.Audit,
  VM.GuestAgent.Unrestricted, VM.PowerMgmt
PVEDatastoreUser on /storage/local-lvm (provision user only)
InuconNodeAudit (Sys.Audit) on /nodes/eevee (both users)
InuconMode (VM.Audit, VM.Config.Options, VM.PowerMgmt) on /vms/9200 and /vms/9300
```

Each user gets a `portal-<suffix>` token with `privsep=0`, inheriting only that dedicated user's scoped ACL. Stream each one-time `pveum user token add --output-format json` value through local `jq` directly into its own age file, prefixed with the matching token ID; never store both in a shell variable or plaintext file. If encryption fails, remove only the just-created exact token ID and incomplete ciphertext, then exit. Verify `pveum user permissions` and `pveum user token permissions` show no VM100 access and no mode access from the provision token. Add a separate `--smoke-plan/--smoke-apply --canary-vmid <explicit-unused-vmid>` mode for Task15: it runs a fixed Node program inside the portal pod so token values remain in process environment, clone/observe/delete is exact, mode verification writes only the observed `onboot` value, and default remains read-only. Do not remove the current `portal@pve!inucon` token or its global ACL in this step.

- [ ] **Step 6: Derive runner and tunnel EnvironmentFiles without reading benchvm plaintext files**

Stream the runner token from the same k3s Secret into a fixed non-secret envelope. Obtain a fresh connector token inside the portal pod and stream it straight to age:

```bash
{
  printf 'PORTAL_URL=http://192.0.2.20:30080\n'
  printf 'RUNNER_TOKEN='
  ssh -o BatchMode=yes apphost.kisen.one \
    "kubectl -n inucon get secret inucon-portal-env -o jsonpath='{.data.RUNNER_TOKEN}'" |
    base64 -d
  printf '\nBENCH_DIR=/home/kise/private-isu/benchmarker\n'
  printf 'RUNNER_ID=benchvm\n'
} | encrypt_age_rule runner-env.age secrets/runner-env.age

ssh -o BatchMode=yes apphost.kisen.one \
  "kubectl -n inucon exec deploy/inucon-portal -- node -e '
    const base = \"https://api.cloudflare.com/client/v4/accounts/\";
    const url = base + process.env.CF_ACCOUNT_ID + \"/cfd_tunnel/\" + process.env.CF_TUNNEL_ID + \"/token\";
    fetch(url, { method: \"GET\", headers: { authorization: \"Bearer \" + process.env.CF_API_TOKEN } })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok || body.success !== true || typeof body.result !== \"string\") {
          process.exitCode = 1;
          return;
        }
        process.stdout.write(\"TUNNEL_TOKEN=\" + body.result + \"\\n\");
      })
      .catch(() => { process.exitCode = 1; });
  '" | encrypt_age_rule inucon-tunnel-token.age secrets/inucon-tunnel-token.age
```

The connector response is never printed. Decoded token values flow only through pipes into age.

- [ ] **Step 7: Implement Nix secret distribution**

apphost declares `age.secrets.inucon-portal-env`, `age.secrets.inucon-proxmox-provision`, and `age.secrets.inucon-proxmox-mode`; a root oneshot after k3s runs:

```sh
kubectl create secret generic inucon-portal-env -n inucon \
  --from-env-file="$CREDENTIALS_DIRECTORY/portal.env" \
  --from-env-file="$CREDENTIALS_DIRECTORY/proxmox-provision.env" \
  --from-env-file="$CREDENTIALS_DIRECTORY/proxmox-mode.env" \
  --dry-run=client -o yaml | kubectl apply -f -
```

Use systemd credentials or the agenix runtime path; never interpolate file contents into the Nix store. Restart the portal deployment only when it exists. benchvm points both service `EnvironmentFile` values at their age runtime paths. Wrap the runner `ExecStart` in a Nix-store shell script that exports non-secret `RUNNER_REVISION` from `${pkgs.git}/bin/git -C /home/kise/inucon rev-parse HEAD` immediately before `exec`; fail startup if the checkout has no commit rather than encrypting a revision that becomes stale before rollout.

- [ ] **Step 8: Run Nix checks and inspect unit output for plaintext absence**

Run:

```bash
nix flake check
nix eval --json '.#nixosConfigurations.apphost.config.systemd.services.inucon-portal-secret-sync.serviceConfig'
nix eval --json '.#nixosConfigurations.benchvm.config.systemd.services.inucon-runner.serviceConfig.EnvironmentFile'
nix eval --json '.#nixosConfigurations.benchvm.config.systemd.services.cloudflared-inucon.serviceConfig.EnvironmentFile'
```

Expected: checks PASS, only runtime paths are visible, and no token/secret value is printed.

- [ ] **Step 9: Commit only intended sibling-repo files**

```bash
chmod +x scripts/provision-inucon-proxmox-credentials.sh
git add secrets/secrets.nix secrets/inucon-portal-env.age secrets/inucon-proxmox-provision.age secrets/inucon-proxmox-mode.age secrets/runner-env.age secrets/inucon-tunnel-token.age scripts/provision-inucon-proxmox-credentials.sh hosts/apphost/configuration.nix hosts/benchvm/configuration.nix tests/inucon-secrets.nix flake.nix docs/runbooks/apphost-cloudflared.md
git commit --no-gpg-sign -m "feat(inucon): manage runtime credentials with agenix"
```

---

### Task 15: Recovery runbooks, full verification, reviewed rollout, and first reconciliation

**Files:**
- Create: `docs/runbooks/contest-recovery.md`
- Modify: `docs/runbooks/contest-operations.md`
- Modify: `deploy/README.md`
- Modify: `README.md`
- Create: `docs/superpowers/reviews/2026-08-13-contest-lifecycle-rollout.md`
- Modify: `docs/superpowers/specs/2026-08-13-contest-lifecycle-automation-design.md` only if implementation discovered a factual interface change; record the reason rather than silently drifting.

**Interfaces:**
- Consumes: all previous tasks and both repository branches.
- Produces: operator-normal flow entirely in Web, failure-only recovery commands, verified production migration, clean first reconciliation, and a ready path to create edition2 after actual dates are supplied.

- [ ] **Step 1: Write runbooks by block condition**

Document exact recovery for stale plan, ambiguous Cloudflare policy, duplicate DNS, missing VM, shutdown timeout, insufficient RAM, stale runner, backup unavailable, failed cleanup, migration rollback, and credential rotation. Normal flow references Admin Web and does not instruct direct SQL or routine dashboard edits.

- [ ] **Step 2: Run full local verification**

Run outside the socket-restricted sandbox where required:

```bash
pnpm -r typecheck
pnpm -r test
pnpm -r build
docker build -f deploy/Dockerfile -t inucon-portal:contest-automation .
```

Expected: typecheck/build exit0; portal, runner, and Web test suites have zero failures; Docker build succeeds.

- [ ] **Step 3: Commit runbooks and obtain code review**

```bash
git add docs/runbooks/contest-recovery.md docs/runbooks/contest-operations.md deploy/README.md README.md docs/superpowers/specs/2026-08-13-contest-lifecycle-automation-design.md
git commit --no-gpg-sign -m "docs: define repeatable contest operations"
```

Use the repository review workflow against `develop`. Resolve every correctness/security/data-loss finding and rerun Step2. Stop for explicit user approval before PR merge or production change.

- [ ] **Step 4: Create an off-host pre-migration snapshot on this WSL**

After deployment approval, create `/home/kise/backups/inucon` mode0700 and build/import the reviewed feature image without changing the running Deployment. Apply only `deploy/k8s/backup-pvc.yaml`, then create a one-shot Kubernetes Job from that image mounting the existing DB PVC read/write (required by SQLite's online backup API) and backup PVC; its command is `node portal/dist/cli/backup.js --source /data/portal.db --destination /backups/portal-before-multi-contest-<UTC timestamp>.db` and never starts portal main or the migrator. Wait for exit0, copy the snapshot to the same filename under `/home/kise/backups/inucon`, calculate SHA-256 locally, run `PRAGMA integrity_check`, compare with the CLI JSON metadata, then remove only the completed Job while keeping both snapshot copies. Record path/hash in the rollout report and do not delete the only off-host snapshot after migration.

- [ ] **Step 5: Dry-run migration against a copy**

Copy the snapshot to a task-specific `/tmp/inucon-migration-dry-run.<pid>/portal.db`, run the new image/migrator against that copy, then query exact row counts, edition1 metadata, scores 1077/910, instance status, job counts, and `PRAGMA foreign_key_check`. Any mismatch stops rollout before production DB or deployment changes.

- [ ] **Step 6: Merge through develop/main policy and deploy manifests/image**

After explicit approval, merge the INUCON feature PR to develop, create and merge develop-to-main PR, and merge the reviewed `nixos-config-private` credential branch through that repository's policy. Build from the resulting INUCON main commit, apply namespace/PVC/deployment/service/ingress manifests including backup PVC, import the image to apphost, and wait for rollout health. Record both exact repository commits and the image digest.

- [ ] **Step 7: Deploy Nix secrets and retire superseded credentials/files**

Deploy apphost config, verify k3s Secret key names without values and portal health, then exercise read-only inventory through both new Proxmox credentials. Run a reviewed portal-adapter smoke operation that first proves a reserved canary VMID is absent, linked-clones template9100 into `inucon-team-vms` without starting it, observes it, deletes it, and proves absence; for the mode credential, write the already-observed `onboot` value back to VMIDs9200/9300 and re-read it without changing power state. Any unknown result stops for inventory/recovery instead of revocation. Capture `pveum acl list`, the old token metadata without value, and `/etc/pve/user.cfg` into the mode0700 off-host rollout backup. Then remove exact old token `portal@pve!inucon` and the global `/` ACL for `portal@pve`; verify the new provision credential cannot access VM100 or power VMIDs9200/9300 and the new mode credential cannot clone/delete team VMs. Deploy benchvm config while benchvm is available and verify runner heartbeat and tunnel connection. Only after both services use `/run/agenix/...`, remove exact old files `/home/kise/.inucon/runner-env` and `/root/.inucon-tunnel-env`; report that token/file removal requires creating a fresh credential or decrypting the new age ciphertext for recovery.

- [ ] **Step 8: Verify edition1 and complete its archive before provider mutation**

Compare public API/UI score and job counts with pre-migration evidence. Confirm edition1 is finished, users/teams remain, DB Instance team1-1 is still represented for reconciliation, and no resource was silently marked deleted by migration. From Admin Web run the finished-Contest archive Operation, verify JSON/CSV checksums and DB snapshot integrity, download the DB snapshot to the mode0700 off-host directory from Step4, verify its SHA-256, then mark that exact checksum off-host verified. This operation must not alter provider state, jobs, or scoreboard values.

- [ ] **Step 9: Run and approve first reconciliation plan**

Refresh inventory. Expected plan: team1-1 missing Proxmox VM plus Cloudflare cleanup; team2-1 unmanaged Cloudflare orphan blocked. Select adopt for exact hostname `inucon-team2-1.kisen.one`, review that catch-all/portal/unrelated resources show no action, apply once, and follow Operation steps to terminal status.

- [ ] **Step 10: Prove post-cleanup state is clean**

Re-run reconciliation and independently read provider APIs. Required result: active edition1 Instance count0, Proxmox `inucon-team*` count0, Cloudflare `inucon-team*` DNS/ingress/Access app count0, catch-all preserved, edition1 score unchanged, portal healthy.

- [ ] **Step 11: Create edition2 draft only after dates are provided**

Use Admin Web with edition2, one Team on team1, quota3, desiredInstanceCount3, templateVmid9100, the verified problem revision, and operator-supplied approximately seven-day schedule. Do not guess dates. Save as draft; enter preparing only after the operator confirms devvm work is saved and readiness is all pass.

- [ ] **Step 12: Commit rollout evidence without secrets**

Create `docs/superpowers/reviews/2026-08-13-contest-lifecycle-rollout.md` containing commit/digest, snapshot hash but not DB contents, migration counts, provider resource counts, test totals, reconciliation Operation ID, and remaining human checks. Scan it for token, email, Authorization header, and secret material before committing.

```bash
git add docs/superpowers/reviews/2026-08-13-contest-lifecycle-rollout.md
git commit --no-gpg-sign -m "docs: record contest automation rollout"
```

---

## Final Verification Matrix

| Requirement | Evidence |
| --- | --- |
| 第1回 archive/score 不変 | migration0004/0005 tests、HTTP archive tests、rollout Step8 |
| 開催回別 Team/VM/job/score | repository tests、HTTP tests |
| 第2回1チーム3台約7日を設定 | wizard component/API tests、rollout Step11 |
| Web plan/apply と監査履歴 | OperationRepo/worker/HTTP/Web tests |
| 第1回 orphan cleanup | reconciliation legacy fixture、rollout Steps9-10 |
| safe contest mode | mode operation tests、readiness tests |
| exact Cloudflare Access | Cloudflare adapter tests、reconciliation tests |
| rehearsal と guarded start | runner/bench/readiness tests |
| scheduled end と result archive | TestClock scheduler、finalization/artifact tests |
| cleanup と normal return | cleanup/mode tests |
| restart/retry/idempotency | Operation worker restart tests、provider timeout tests |
| agenix source of truth | Nix checks、unit evaluation、live EnvironmentFile verification |
| 人間作業の限定 | contest-recovery runbook と rollout report |
