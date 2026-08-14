import { SqlClient } from "@effect/sql"
import { Effect, Layer, Option } from "effect"
import type { ContestId, InstanceId, TeamId } from "../../../domain/ids.js"
import { Instance } from "../../../domain/instance.js"
import { DuplicateInstanceIndex } from "../../../domain/errors.js"
import { ProvisionInProgress, QuotaExceeded } from "../../../application/errors.js"
import { InstanceRepo } from "../../../application/ports.js"
import { RepoError } from "../../../application/ports.js"
import { decodeRow, optionToNull, wrapSqlError } from "./support.js"

interface InstanceRow {
  readonly id: string
  readonly contestId: string
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

const INSTANCE_COLUMNS = `
  id, contest_id AS contestId, team_id AS teamId, idx AS "index", vmid,
  private_ip AS privateIp, status,
  progress, error_message AS errorMessage, created_at AS createdAt, updated_at AS updatedAt
`

const decodeInstance = (row: InstanceRow) =>
  Effect.try({
    try: () => JSON.parse(row.progress) as unknown,
    catch: (cause) => new RepoError({ cause })
  }).pipe(Effect.flatMap((progress) => decodeRow(Instance, { ...row, progress })))

export const InstanceRepoLive: Layer.Layer<InstanceRepo, never, SqlClient.SqlClient> = Layer.effect(
  InstanceRepo,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const columns = sql.literal(INSTANCE_COLUMNS)

    return {
      listByContest: (contestId: ContestId) =>
        wrapSqlError(
          sql<InstanceRow>`SELECT ${columns} FROM instances WHERE contest_id = ${contestId} ORDER BY team_id, idx`
        ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, decodeInstance))),

      listByTeam: (contestId: ContestId, teamId: TeamId) =>
        wrapSqlError(
          sql<InstanceRow>`
            SELECT ${columns} FROM instances
            WHERE contest_id = ${contestId} AND team_id = ${teamId}
            ORDER BY idx
          `
        ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, decodeInstance))),

      findById: (id: InstanceId) =>
        wrapSqlError(sql<InstanceRow>`SELECT ${columns} FROM instances WHERE id = ${id}`).pipe(
          Effect.flatMap((rows) =>
            rows.length === 0
              ? Effect.succeed(Option.none())
              : decodeInstance(rows[0]).pipe(Effect.map(Option.some))
          )
        ),

      // 台帳取り込み(admin)。(contest_id, team_id, idx) の重複判定は
      // migration 0005 の部分ユニーク index(status != 'deleted')と同条件で
      // WHERE NOT EXISTS ... RETURNING の単一原子的操作で行う。
      create: (i: Instance) =>
        Effect.gen(function* () {
          const rows = yield* wrapSqlError(
            sql<InstanceRow>`
              INSERT INTO instances
                (id, contest_id, team_id, idx, vmid, private_ip, status, progress, error_message, created_at, updated_at)
              SELECT
                ${i.id}, ${i.contestId}, ${i.teamId}, ${i.index}, ${i.vmid}, ${i.privateIp}, ${i.status},
                ${JSON.stringify(i.progress)}, ${optionToNull(i.errorMessage)}, ${i.createdAt}, ${i.updatedAt}
              WHERE NOT EXISTS (
                SELECT 1 FROM instances
                WHERE contest_id = ${i.contestId} AND team_id = ${i.teamId} AND idx = ${i.index}
                  AND status != 'deleted'
              )
              RETURNING ${columns}
            `
          )
          if (rows.length === 0) {
            return yield* Effect.fail(new DuplicateInstanceIndex({ teamId: i.teamId, index: i.index }))
          }
          return yield* decodeInstance(rows[0])
        }),

      remove: (id: InstanceId) => wrapSqlError(sql`DELETE FROM instances WHERE id = ${id}`).pipe(Effect.asVoid),

      // (1) quota 判定・(2) 同 contest 同 team の進行中 1 本ガード・(3) 重複 idx
      // ガードすべて contest スコープに絞った条件で単一原子的 INSERT を組み立てる。
      createIfAllowed: (i: Instance, quota: number) =>
        wrapSqlError(
          sql.withTransaction(
            Effect.gen(function* () {
              const rows = yield* sql<InstanceRow>`
                INSERT INTO instances
                  (id, contest_id, team_id, idx, vmid, private_ip, status, progress, error_message, created_at, updated_at)
                SELECT
                  ${i.id}, ${i.contestId}, ${i.teamId}, ${i.index}, ${i.vmid}, ${i.privateIp}, ${i.status},
                  ${JSON.stringify(i.progress)}, ${optionToNull(i.errorMessage)}, ${i.createdAt}, ${i.updatedAt}
                WHERE
                  (
                    SELECT COUNT(*) FROM instances
                    WHERE contest_id = ${i.contestId} AND team_id = ${i.teamId}
                      AND status IN ('creating', 'running')
                  ) < ${quota}
                  AND NOT EXISTS (
                    SELECT 1 FROM instances
                    WHERE contest_id = ${i.contestId} AND team_id = ${i.teamId}
                      AND status IN ('creating', 'deleting')
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM instances
                    WHERE contest_id = ${i.contestId} AND team_id = ${i.teamId} AND idx = ${i.index}
                      AND status != 'deleted'
                  )
                RETURNING ${columns}
              `
              if (rows.length > 0) {
                return yield* decodeInstance(rows[0])
              }

              const activeCountRows = yield* sql<{ activeCount: number }>`
                SELECT COUNT(*) AS activeCount FROM instances
                WHERE contest_id = ${i.contestId} AND team_id = ${i.teamId} AND status IN ('creating', 'running')
              `
              if (activeCountRows[0].activeCount >= quota) {
                return yield* Effect.fail(new QuotaExceeded({ teamId: i.teamId, quota }))
              }

              const inProgressRows = yield* sql<{ id: string }>`
                SELECT id FROM instances
                WHERE contest_id = ${i.contestId} AND team_id = ${i.teamId}
                  AND status IN ('creating', 'deleting')
              `
              if (inProgressRows.length > 0) {
                return yield* Effect.fail(new ProvisionInProgress({ teamId: i.teamId }))
              }

              return yield* Effect.fail(new DuplicateInstanceIndex({ teamId: i.teamId, index: i.index }))
            })
          )
        ),

      // 対象 instance の contest_id/team_id で scoping。全条件は 0004 の設計を踏襲。
      beginDeletingIfAllowed: (instanceId: InstanceId, now: number) =>
        wrapSqlError(
          sql<InstanceRow>`
            UPDATE instances
            SET status = 'deleting', updated_at = ${now}
            WHERE id = ${instanceId}
              AND status IN ('running', 'failed')
              AND NOT EXISTS (
                SELECT 1 FROM instances i2
                WHERE i2.contest_id = instances.contest_id
                  AND i2.team_id = instances.team_id
                  AND i2.id <> ${instanceId}
                  AND i2.status IN ('creating', 'deleting')
              )
              AND NOT EXISTS (
                SELECT 1 FROM bench_jobs bj
                WHERE bj.contest_id = instances.contest_id
                  AND bj.target_ip = instances.private_ip
                  AND bj.status IN ('queued', 'running')
              )
            RETURNING ${columns}
          `
        ).pipe(
          Effect.flatMap((rows) =>
            rows.length === 0
              ? Effect.succeed(Option.none<Instance>())
              : decodeInstance(rows[0]).pipe(Effect.map(Option.some))
          )
        ),

      update: (i: Instance) =>
        wrapSqlError(
          sql`
            UPDATE instances
            SET vmid = ${i.vmid}, private_ip = ${i.privateIp}, status = ${i.status},
                progress = ${JSON.stringify(i.progress)}, error_message = ${optionToNull(i.errorMessage)},
                updated_at = ${i.updatedAt}
            WHERE id = ${i.id}
          `
        ).pipe(Effect.asVoid),

      // ワーカーは全 contest 横断で拾う(オーケストレーション対象は Contest に
      // 縛らずキュー全体で最古 1 件を進める)。
      findNextForOrchestration: wrapSqlError(
        sql<InstanceRow>`
          SELECT ${columns} FROM instances
          WHERE status IN ('creating', 'deleting')
          ORDER BY created_at, id
          LIMIT 1
        `
      ).pipe(
        Effect.flatMap((rows) =>
          rows.length === 0
            ? Effect.succeed(Option.none<Instance>())
            : decodeInstance(rows[0]).pipe(Effect.map(Option.some))
        )
      )
    }
  })
)
