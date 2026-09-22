import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

// Task 10: runner_agents.revision を INTEGER から TEXT に変更する forward-only
// migration。runner_agents は Task 6 で作られたが、当時は spec のポール契約が
// 未確定で revision を integer と仮に置いていた。Task 10 で正式化した
// RunnerPollRequest は revision を git commit hash 相当の非負文字列
// (dev 環境では "dev")と規定しているため、DB 側もそれに合わせる。
//
// 通常運用では runner_agents はまだ生行を持たない(Task 6 の repo は upsert が
// 一度も呼ばれておらず、production db でも空)ため、CAST(revision AS TEXT) で
// 既存行を保全しつつ列型だけを切り替える。SQLite は ALTER COLUMN TYPE を
// 直接持たないため、他の migration と同じ「rename → CREATE new → INSERT SELECT
// → DROP old」の rebuild パターンで実施する。
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE runner_agents RENAME TO runner_agents_old`

  yield* sql`
    CREATE TABLE runner_agents (
      id TEXT PRIMARY KEY,
      revision TEXT NOT NULL,
      bench_ready INTEGER NOT NULL CHECK (bench_ready IN (0, 1)),
      health_summary TEXT NOT NULL CHECK (length(health_summary) <= 256),
      last_seen_at INTEGER NOT NULL
    )
  `

  yield* sql`
    INSERT INTO runner_agents (id, revision, bench_ready, health_summary, last_seen_at)
    SELECT id, CAST(revision AS TEXT), bench_ready, health_summary, last_seen_at
    FROM runner_agents_old
  `

  yield* sql`DROP TABLE runner_agents_old`
})
