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

      // 台帳取り込み(admin)。(contest_id, team_id, idx) の重複判定と
      // vmid の重複判定はどちらも migration 0005 の部分ユニーク index
      // (status != 'deleted')と同条件で WHERE NOT EXISTS で先取りする。
      // vmid ガードを SELECT 側で持たないと idx_instances_vmid_active の
      // 一意制約違反が SqlError → 500 に化ける。
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
              AND NOT EXISTS (
                SELECT 1 FROM instances
                WHERE vmid = ${i.vmid} AND status != 'deleted'
              )
              RETURNING ${columns}
            `
          )
          if (rows.length === 0) {
            // vmid 側の衝突なら旧 contest の残骸を掃除する必要があることが
            // わかるよう log に残す。返す型は DuplicateInstanceIndex を維持
            // (409 のまま — API 契約変更なし)。
            const vmidConflict = yield* wrapSqlError(sql<{ contestId: string }>`
              SELECT contest_id AS contestId FROM instances
              WHERE vmid = ${i.vmid} AND status != 'deleted'
            `)
            if (vmidConflict.length > 0) {
              yield* Effect.logWarning(
                `create: vmid ${i.vmid} is held by a non-deleted instance in contest ${vmidConflict[0].contestId}; cannot provision for contest ${i.contestId}`
              )
            }
            return yield* Effect.fail(new DuplicateInstanceIndex({ teamId: i.teamId, index: i.index }))
          }
          return yield* decodeInstance(rows[0])
        }),

      remove: (id: InstanceId) => wrapSqlError(sql`DELETE FROM instances WHERE id = ${id}`).pipe(Effect.asVoid),

      // (1) quota 判定・(2) 同 contest 同 team の進行中 1 本ガード・(3) 重複 idx
      // ガード・(4) 重複 vmid ガード をすべて単一原子的 INSERT に組み立てる。
      // (4) は 0005 で追加した idx_instances_vmid_active(非 deleted 全域で
      // vmid ユニーク)を SELECT 側でも先取りするためのもの。読取ガードなしに
      // 走らせるとエディション跨ぎの vmid 衝突(旧エディションの failed 行が
      // vmid を掴んだままなど)が SqlError→ 500 に化けてハンドラの
      // catchTags を素通りするので、SELECT で 0 行にして typed error に落とす。
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
                  AND NOT EXISTS (
                    SELECT 1 FROM instances
                    WHERE vmid = ${i.vmid} AND status != 'deleted'
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

              // idx 側の衝突と vmid 側の衝突を診断で区別する。vmid 側なら
              // クロスエディションの残骸(旧 contest の failed/running 行など)
              // を掃除する必要があることが operator に伝わるよう log にも残す。
              const vmidConflictRows = yield* sql<{ contestId: string }>`
                SELECT contest_id AS contestId FROM instances
                WHERE vmid = ${i.vmid} AND status != 'deleted'
              `
              if (vmidConflictRows.length > 0) {
                yield* Effect.logWarning(
                  `createIfAllowed: vmid ${i.vmid} is held by a non-deleted instance in contest ${vmidConflictRows[0].contestId}; cannot provision for contest ${i.contestId}`
                )
                return yield* Effect.fail(new DuplicateInstanceIndex({ teamId: i.teamId, index: i.index }))
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
