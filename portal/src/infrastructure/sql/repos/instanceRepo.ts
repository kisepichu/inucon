import { SqlClient } from "@effect/sql"
import { Clock, Effect, Layer } from "effect"
import type { InstanceId, TeamId } from "../../../domain/ids.js"
import { Instance } from "../../../domain/instance.js"
import { InstanceRepo } from "../../../application/ports.js"
import { decodeRow, wrapSqlError } from "./support.js"

interface InstanceRow {
  readonly id: string
  readonly teamId: string
  readonly index: number
  readonly privateIp: string
  readonly status: string
}

const decodeInstance = (row: InstanceRow) => decodeRow(Instance, row)

export const InstanceRepoLive: Layer.Layer<InstanceRepo, never, SqlClient.SqlClient> = Layer.effect(
  InstanceRepo,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return {
      listByTeam: (teamId: TeamId) =>
        wrapSqlError(
          sql<InstanceRow>`
            SELECT id, team_id AS teamId, idx AS "index", private_ip AS privateIp, status
            FROM instances WHERE team_id = ${teamId} ORDER BY idx
          `
        ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, decodeInstance))),

      create: (i: Instance) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          yield* wrapSqlError(
            sql`
              INSERT INTO instances (id, team_id, idx, private_ip, status, created_at)
              VALUES (${i.id}, ${i.teamId}, ${i.index}, ${i.privateIp}, ${i.status}, ${now})
            `
          )
        }),

      remove: (id: InstanceId) => wrapSqlError(sql`DELETE FROM instances WHERE id = ${id}`).pipe(Effect.asVoid)
    }
  })
)
