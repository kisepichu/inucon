import { SqlClient } from "@effect/sql"
import { Effect, Layer, Option } from "effect"
import { RunnerAgentRepo } from "../../../application/ports.js"
import { wrapSqlError } from "./support.js"

// Task 6/10: runner_agents 行の touch(upsert)/ getFresh / listAll。
// Task 10 で spec の RunnerAgentRepo 契約に合わせ、revision を string に
// (migration 0007 でカラム型を TEXT に切り替え済み)、`upsert` を `touch` に
// rename、`getFresh(now, maxAgeMillis)` を追加した。runner heartbeat は
// pollJob handler が touch を叩き、readiness の runner check が getFresh を
// 使って「fresh かつ benchReady=true の runner が居るか」を判定する。
interface AgentRow {
  readonly id: string
  readonly revision: string
  readonly benchReady: number
  readonly healthSummary: string
  readonly lastSeenAt: number
}

const decodeRow = (r: AgentRow) => ({
  id: r.id,
  revision: r.revision,
  benchReady: r.benchReady === 1,
  healthSummary: r.healthSummary,
  lastSeenAt: r.lastSeenAt
})

export const RunnerAgentRepoLive: Layer.Layer<RunnerAgentRepo, never, SqlClient.SqlClient> =
  Layer.effect(
    RunnerAgentRepo,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return {
        touch: (a) =>
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

        // 「now - lastSeenAt <= maxAgeMillis」の最新行を返す。0 行なら None。
        // runner が複数居る場合は最新 heartbeat 1 台を採る(spec は「1 台前提、
        // 将来複数に拡張しても最新の 1 台で readiness を語る」と読める)。
        getFresh: (now, maxAgeMillis) =>
          wrapSqlError(
            sql<AgentRow>`
              SELECT id, revision, bench_ready AS benchReady,
                     health_summary AS healthSummary, last_seen_at AS lastSeenAt
              FROM runner_agents
              WHERE ${now} - last_seen_at <= ${maxAgeMillis}
              ORDER BY last_seen_at DESC
              LIMIT 1
            `
          ).pipe(
            Effect.map((rows) =>
              rows.length === 0 ? Option.none() : Option.some(decodeRow(rows[0]))
            )
          ),

        listAll: wrapSqlError(
          sql<AgentRow>`
            SELECT id, revision, bench_ready AS benchReady, health_summary AS healthSummary,
                   last_seen_at AS lastSeenAt
            FROM runner_agents ORDER BY id
          `
        ).pipe(Effect.map((rows) => rows.map(decodeRow)))
      }
    })
  )
