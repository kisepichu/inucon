import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

// Task 6: durable Operation / ResourceBinding / Artifact / RunnerAgent の
// 5 テーブルを新規追加する forward-only migration。
//
// - operations: グローバル単一 unfinished (status NOT IN ('succeeded','canceled'))
//   を partial unique index (idx_operations_single_unfinished, ((1)) WHERE ...)
//   で強制する(Contest の single_operational と同じ手法)。admin actor は
//   必ず userId を要求する(CHECK)。sanitized_error は TEXT nullable。
//   raw bearer / request headers / access email 一覧は絶対に列に載せない。
// - operation_steps: (operation_id, ordinal) と (operation_id, step_key) の
//   複合 unique、cascading FK、progress_json は json_valid CHECK。
// - resource_bindings: 3-tuple (provider, resource_type, canonical_key) が
//   unique。team_id / instance_id は nullable(binding は provider/resource
//   単位、team/instance は「もし紐づくなら」の情報)。
// - contest_artifacts: (contest_id, kind) unique。off_host_status は 3 値の
//   CHECK。generation 列は持たない(再生成は in-place 上書き)。
// - runner_agents: 単一プロセス ID PK。health_summary は 256 文字 CHECK。
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE operations (
      id TEXT PRIMARY KEY,
      contest_id TEXT NOT NULL REFERENCES contests(id),
      kind TEXT NOT NULL CHECK (kind IN (
        'reconcile','enter_contest_mode','prepare','start','finish',
        'revoke_access','cleanup','return_normal_mode','backup'
      )),
      status TEXT NOT NULL CHECK (status IN (
        'queued','running','succeeded','failed','blocked','canceled'
      )),
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('admin','scheduler')),
      actor_user_id TEXT REFERENCES users(id),
      plan_digest TEXT NOT NULL,
      contest_revision INTEGER NOT NULL CHECK (contest_revision > 0),
      sanitized_error TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      CHECK (actor_kind = 'scheduler' OR actor_user_id IS NOT NULL)
    )
  `

  // グローバル単一 unfinished Operation。定数 (1) を式にすると partial unique
  // 全体で 1 行しか成り立たなくなる(Contest の single_operational と同型)。
  yield* sql`
    CREATE UNIQUE INDEX idx_operations_single_unfinished
    ON operations ((1)) WHERE status NOT IN ('succeeded','canceled')
  `

  yield* sql`
    CREATE INDEX idx_operations_contest_created
    ON operations (contest_id, created_at DESC)
  `

  yield* sql`
    CREATE TABLE operation_steps (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      step_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','blocked')),
      attempt INTEGER NOT NULL CHECK (attempt >= 0),
      continue_on_error INTEGER NOT NULL DEFAULT 0 CHECK (continue_on_error IN (0, 1)),
      retry_at INTEGER,
      lease_expires_at INTEGER,
      input_summary TEXT NOT NULL,
      progress_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress_json)),
      result_summary TEXT,
      sanitized_error TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      UNIQUE (operation_id, ordinal),
      UNIQUE (operation_id, step_key)
    )
  `

  // claimNext が「同 Operation の running Step があるか」を効率的に判定するため。
  yield* sql`
    CREATE INDEX idx_operation_steps_operation_ordinal
    ON operation_steps (operation_id, ordinal)
  `

  yield* sql`
    CREATE TABLE resource_bindings (
      id TEXT PRIMARY KEY,
      contest_id TEXT NOT NULL REFERENCES contests(id),
      team_id TEXT,
      instance_id TEXT,
      provider TEXT NOT NULL CHECK (provider IN ('cloudflare','proxmox','runner','backup')),
      resource_type TEXT NOT NULL CHECK (resource_type IN (
        'dns_record','tunnel_ingress','access_application','access_policy',
        'vm','runner_agent','backup_artifact'
      )),
      canonical_key TEXT NOT NULL,
      external_id TEXT,
      desired_state TEXT NOT NULL,
      last_observed_state TEXT,
      last_observed_at INTEGER,
      UNIQUE (provider, resource_type, canonical_key)
    )
  `

  yield* sql`
    CREATE INDEX idx_resource_bindings_contest
    ON resource_bindings (contest_id)
  `

  yield* sql`
    CREATE TABLE contest_artifacts (
      id TEXT PRIMARY KEY,
      contest_id TEXT NOT NULL REFERENCES contests(id),
      kind TEXT NOT NULL CHECK (kind IN ('scoreboard','scoreboard_csv','snapshot')),
      storage_path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      off_host_status TEXT NOT NULL CHECK (off_host_status IN ('not_applicable','pending','verified')),
      verified_at INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE (contest_id, kind)
    )
  `

  yield* sql`
    CREATE TABLE runner_agents (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      bench_ready INTEGER NOT NULL CHECK (bench_ready IN (0, 1)),
      health_summary TEXT NOT NULL CHECK (length(health_summary) <= 256),
      last_seen_at INTEGER NOT NULL
    )
  `
})
