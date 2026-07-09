import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

// Phase 2 リリース前(本番 DB がまだ存在しない)の今だけ、0001 を書き換えて
// 全 8 テーブルを 1 マイグレーションにまとめている。本番運用開始後は新規
// マイグレーションファイルを追加する方式に切り替えること。
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      github_id INTEGER NOT NULL UNIQUE,
      github_login TEXT NOT NULL,
      display_name TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `

  yield* sql`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `

  yield* sql`
    CREATE TABLE teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      team_number INTEGER NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    )
  `

  yield* sql`
    CREATE TABLE team_members (
      team_id TEXT NOT NULL REFERENCES teams(id),
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
      PRIMARY KEY (team_id, user_id)
    )
  `

  yield* sql`
    CREATE TABLE contests (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      problem_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('preparing','running','finished'))
    )
  `

  yield* sql`
    CREATE TABLE instances (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id),
      idx INTEGER NOT NULL,
      private_ip TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      UNIQUE (team_id, idx)
    )
  `

  yield* sql`
    CREATE TABLE bench_jobs (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id),
      target_ip TEXT NOT NULL,
      target_port INTEGER NOT NULL DEFAULT 80,
      status TEXT NOT NULL CHECK (status IN ('queued','running','finished','canceled','failed')),
      score INTEGER,
      passed INTEGER CHECK (passed IN (0, 1)),
      error_message TEXT,
      enqueued_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      last_progress_at INTEGER
    )
  `

  yield* sql`CREATE INDEX idx_bench_jobs_status ON bench_jobs (status, enqueued_at)`
  yield* sql`CREATE INDEX idx_bench_jobs_team ON bench_jobs (team_id, enqueued_at DESC)`

  yield* sql`
    CREATE TABLE bench_job_logs (
      job_id TEXT PRIMARY KEY REFERENCES bench_jobs(id),
      log TEXT NOT NULL DEFAULT ''
    )
  `
})
