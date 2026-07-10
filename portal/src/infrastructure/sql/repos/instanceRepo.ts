import { SqlClient } from "@effect/sql"
import { Effect, Layer, Option } from "effect"
import type { InstanceId, TeamId } from "../../../domain/ids.js"
import { Instance } from "../../../domain/instance.js"
import { DuplicateInstanceIndex } from "../../../domain/errors.js"
import { InstanceRepo } from "../../../application/ports.js"
import { decodeRow, optionToNull, wrapSqlError } from "./support.js"

interface InstanceRow {
  readonly id: string
  readonly teamId: string
  readonly index: number
  readonly vmid: number
  readonly privateIp: string
  readonly status: string
  readonly progress: string
  readonly errorMessage: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

// SELECT / RETURNING で共通して使う列リスト(BENCH_JOB_COLUMNS と同じ方針)。
// progress は JSON 配列を TEXT で保持する(migration 0002)ため、decode 時に
// JSON.parse してから Schema.decodeUnknown に渡す。
const INSTANCE_COLUMNS = `
  id, team_id AS teamId, idx AS "index", vmid, private_ip AS privateIp, status,
  progress, error_message AS errorMessage, created_at AS createdAt, updated_at AS updatedAt
`

const decodeInstance = (row: InstanceRow) =>
  decodeRow(Instance, { ...row, progress: JSON.parse(row.progress) as unknown })

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

      // POST /api/bench-jobs: instanceId 指定時に privateIp を解決するために使う。
      findById: (id: InstanceId) =>
        wrapSqlError(sql<InstanceRow>`SELECT ${columns} FROM instances WHERE id = ${id}`).pipe(
          Effect.flatMap((rows) =>
            rows.length === 0
              ? Effect.succeed(Option.none())
              : decodeInstance(rows[0]).pipe(Effect.map(Option.some))
          )
        ),

      // (team_id, idx) の重複判定は migration 0002 の部分ユニークインデックス
      // (status IN ('creating','running','deleting'))と同条件で行う。
      // deleted/failed の行があっても同 idx を再作成できる。判定と INSERT は
      // 「INSERT ... SELECT ... WHERE NOT EXISTS ... RETURNING」の単一原子的操作
      // (TOCTOU 回避、teamRepo.create / benchJobRepo.insertIfAllowed と同じ形)。
      create: (i: Instance) =>
        Effect.gen(function* () {
          const rows = yield* wrapSqlError(
            sql<InstanceRow>`
              INSERT INTO instances
                (id, team_id, idx, vmid, private_ip, status, progress, error_message, created_at, updated_at)
              SELECT
                ${i.id}, ${i.teamId}, ${i.index}, ${i.vmid}, ${i.privateIp}, ${i.status},
                ${JSON.stringify(i.progress)}, ${optionToNull(i.errorMessage)}, ${i.createdAt}, ${i.updatedAt}
              WHERE NOT EXISTS (
                SELECT 1 FROM instances
                WHERE team_id = ${i.teamId} AND idx = ${i.index}
                  AND status IN ('creating', 'running', 'deleting')
              )
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
