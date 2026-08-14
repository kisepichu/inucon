import { SqlClient } from "@effect/sql"
import { Effect, Layer, Option } from "effect"
import { Contest } from "../../../domain/contest.js"
import { ContestRepo } from "../../../application/ports.js"
import { decodeRow, wrapSqlError } from "./support.js"

// Task 1: contests テーブルが 20 列(edition/problemRevision/templateVmid/
// schedule 4/closed 2/state timestamps 4/revision)に拡大したため、明示的に
// 全列を SELECT / INSERT する。単一 contest 運用は Task 3 で解消され、
// getCurrent は「preparing/running/finalizing の 1 行」を返すよう更新される
// (spec §「同時に進行中の Contest は 1 つ」の partial unique index を利用)。
//
// 現時点 (Task 1) では contests は依然 1 行運用の互換ブリッジ層のため、
// getCurrent は先頭行を返し、save は全削除→INSERT で置き換える。
const columns = `
  id, edition, name, problem_key AS problemKey, problem_revision AS problemRevision,
  template_vmid AS templateVmid, status, instance_quota AS instanceQuota,
  scheduled_start_at AS scheduledStartAt, scheduled_end_at AS scheduledEndAt,
  access_closes_at AS accessClosesAt, cleanup_at AS cleanupAt,
  access_closed_at AS accessClosedAt, cleanup_completed_at AS cleanupCompletedAt,
  started_at AS startedAt, finalizing_at AS finalizingAt,
  finished_at AS finishedAt, canceled_at AS canceledAt,
  revision
`

export const ContestRepoLive: Layer.Layer<ContestRepo, never, SqlClient.SqlClient> = Layer.effect(
  ContestRepo,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return {
      getCurrent: wrapSqlError(sql`SELECT ${sql.unsafe(columns)} FROM contests LIMIT 1`).pipe(
        Effect.flatMap((rows) =>
          rows.length === 0
            ? Effect.succeed(Option.none<Contest>())
            : decodeRow(Contest, rows[0]).pipe(Effect.map(Option.some))
        )
      ),

      save: (c: Contest) =>
        wrapSqlError(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM contests`
              yield* sql`
                INSERT INTO contests (
                  id, edition, name, problem_key, problem_revision, template_vmid,
                  status, instance_quota,
                  scheduled_start_at, scheduled_end_at, access_closes_at, cleanup_at,
                  access_closed_at, cleanup_completed_at,
                  started_at, finalizing_at, finished_at, canceled_at,
                  revision
                )
                VALUES (
                  ${c.id}, ${c.edition}, ${c.name}, ${c.problemKey}, ${c.problemRevision}, ${c.templateVmid},
                  ${c.status}, ${c.instanceQuota},
                  ${Option.getOrNull(c.scheduledStartAt)}, ${Option.getOrNull(c.scheduledEndAt)},
                  ${Option.getOrNull(c.accessClosesAt)}, ${Option.getOrNull(c.cleanupAt)},
                  ${Option.getOrNull(c.accessClosedAt)}, ${Option.getOrNull(c.cleanupCompletedAt)},
                  ${Option.getOrNull(c.startedAt)}, ${Option.getOrNull(c.finalizingAt)},
                  ${Option.getOrNull(c.finishedAt)}, ${Option.getOrNull(c.canceledAt)},
                  ${c.revision}
                )
              `
            })
          )
        )
    }
  })
)
