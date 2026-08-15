import { SqlClient } from "@effect/sql"
import { Effect, Layer } from "effect"
import { RunnerAgentRepo } from "../../../application/ports.js"
import { wrapSqlError } from "./support.js"

// Task 6: runner_agents 行の upsert / 一覧。runner heartbeat handler (Task 10)
// が upsert を叩き、admin readiness handler が listAll で表示する。
interface AgentRow {
  readonly id: string
  readonly revision: number
  readonly benchReady: number
  readonly healthSummary: string
  readonly lastSeenAt: number
}

export const RunnerAgentRepoLive: Layer.Layer<RunnerAgentRepo, never, SqlClient.SqlClient> =
  Layer.effect(
    RunnerAgentRepo,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return {
        upsert: (a) =>
          wrapSqlError(
            sql`
              INSERT INTO runner_agents (id, revision, bench_ready, health_summary, last_seen_at)
              VALUES (${a.id}, ${a.revision}, ${a.benchReady ? 1 : 0}, ${a.healthSummary}, ${a.lastSeenAt})
              ON CONFLICT (id) DO UPDATE SET
                revision = excluded.revision,
                bench_ready = excluded.bench_ready,
                health_summary = excluded.health_summary,
                last_seen_at = excluded.last_seen_at
            `
          ).pipe(Effect.asVoid),

        listAll: wrapSqlError(
          sql<AgentRow>`
            SELECT id, revision, bench_ready AS benchReady, health_summary AS healthSummary,
                   last_seen_at AS lastSeenAt
            FROM runner_agents ORDER BY id
          `
        ).pipe(
          Effect.map((rows) =>
            rows.map((r) => ({
              id: r.id,
              revision: r.revision,
              benchReady: r.benchReady === 1,
              healthSummary: r.healthSummary,
              lastSeenAt: r.lastSeenAt
            }))
          )
        )
      }
    })
  )
