import { SqlClient } from "@effect/sql"
import { Clock, Effect, Layer } from "effect"
import type { InstanceId, TeamId } from "../../../domain/ids.js"
import { Instance } from "../../../domain/instance.js"
import { DuplicateInstanceIndex } from "../../../domain/errors.js"
import { InstanceRepo } from "../../../application/ports.js"
import { decodeRow, wrapSqlError } from "./support.js"

interface InstanceRow {
  readonly id: string
  readonly teamId: string
  readonly index: number
  readonly privateIp: string
  readonly status: string
}

// SELECT / RETURNING で共通して使う列リスト(BENCH_JOB_COLUMNS と同じ方針)。
const INSTANCE_COLUMNS = `id, team_id AS teamId, idx AS "index", private_ip AS privateIp, status`

const decodeInstance = (row: InstanceRow) => decodeRow(Instance, row)

export const InstanceRepoLive: Layer.Layer<InstanceRepo, never, SqlClient.SqlClient> = Layer.effect(
  InstanceRepo,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const columns = sql.literal(INSTANCE_COLUMNS)

    return {
      listByTeam: (teamId: TeamId) =>
        wrapSqlError(
          sql<InstanceRow>`SELECT ${columns} FROM instances WHERE team_id = ${teamId} ORDER BY idx`
        ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, decodeInstance))),

      // instances.(team_id, idx) の UNIQUE 制約は「INSERT ... SELECT ... WHERE
      // NOT EXISTS ... RETURNING」の単一原子的操作で検出する(TOCTOU 回避、
      // teamRepo.create / benchJobRepo.insertIfAllowed と同じ形)。
      create: (i: Instance) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const rows = yield* wrapSqlError(
            sql<InstanceRow>`
              INSERT INTO instances (id, team_id, idx, private_ip, status, created_at)
              SELECT ${i.id}, ${i.teamId}, ${i.index}, ${i.privateIp}, ${i.status}, ${now}
              WHERE NOT EXISTS (SELECT 1 FROM instances WHERE team_id = ${i.teamId} AND idx = ${i.index})
              RETURNING ${columns}
            `
          )
          if (rows.length === 0) {
            return yield* Effect.fail(new DuplicateInstanceIndex({ teamId: i.teamId, index: i.index }))
          }
          return yield* decodeInstance(rows[0])
        }),

      remove: (id: InstanceId) => wrapSqlError(sql`DELETE FROM instances WHERE id = ${id}`).pipe(Effect.asVoid)
    }
  })
)
