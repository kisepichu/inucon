import { SqlClient } from "@effect/sql"
import { Effect, Layer, Option } from "effect"
import type { InstanceId, TeamId } from "../../../domain/ids.js"
import { Instance } from "../../../domain/instance.js"
import { DuplicateInstanceIndex } from "../../../domain/errors.js"
import { ProvisionInProgress, QuotaExceeded } from "../../../application/errors.js"
import { InstanceRepo } from "../../../application/ports.js"
import { RepoError } from "../../../application/ports.js"
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
  // progress は TEXT に JSON 配列で保存されている。壊れた値でプロセスを落とさない
  // よう Effect.try でパースし、失敗も RepoError として E チャネルに載せる
  // (後段の Schema.decodeUnknown の失敗と同じ扱い)。
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

      // (team_id, idx) の重複判定は migration 0003 の部分ユニークインデックス
      // (status != 'deleted', Task 6 レビュー #E で failed も予約対象に
      // 変更)と同条件で行う。deleted の行があった idx だけ再作成できる。
      // この WHERE NOT EXISTS の条件を DB のインデックス述語と一致させて
      // おかないと、failed 行との衝突が「NOT EXISTS は通る→INSERT が UNIQUE
      // 制約違反で失敗→RepoError(500)」になってしまい、本来返すべき
      // DuplicateInstanceIndex(409)にならない。判定と INSERT は
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

      // requestCreateInstance(Task 4、追加ボタン)専用の原子的 guard 付き
      // INSERT。単一の INSERT ... SELECT ... WHERE ... RETURNING 文で
      // (1) チームの creating+running 数 < quota、(2) チームに進行中
      // (creating/deleting)が無いこと、(3) (team_id, idx) の重複が無いこと、
      // を検証してから挿入する(TOCTOU 回避、benchJobRepo.insertIfAllowed と
      // 同型)。0 行挿入時は追加の SELECT で原因を優先順位(quota → 進行中 →
      // 重複)で判定する(currentStatusOrDie と同じ「失敗時のみ読み直す」
      // 方針。実際の許可判定は上の単一原子的操作が行っており、この読み直しは
      // 呼び出し元に返すエラー種別を選ぶためだけに使う)。
      // (3) の重複判定は migration 0003 の部分ユニークインデックス
      // (status != 'deleted')と同条件にする(Task 6 レビュー #E)。
      // 呼び出し元(requestCreateInstance)の occupiedIndices が既に
      // deleted 以外を占有中として index を選ぶため通常はここに来ないが、
      // 同一 idx への競合 INSERT が割り込んだ場合の TOCTOU backstop として
      // DB のインデックスと同じ条件で弾く必要がある。
      createIfAllowed: (i: Instance, quota: number) =>
        wrapSqlError(
          sql.withTransaction(
            Effect.gen(function* () {
              const rows = yield* sql<InstanceRow>`
                INSERT INTO instances
                  (id, team_id, idx, vmid, private_ip, status, progress, error_message, created_at, updated_at)
                SELECT
                  ${i.id}, ${i.teamId}, ${i.index}, ${i.vmid}, ${i.privateIp}, ${i.status},
                  ${JSON.stringify(i.progress)}, ${optionToNull(i.errorMessage)}, ${i.createdAt}, ${i.updatedAt}
                WHERE
                  (
                    SELECT COUNT(*) FROM instances
                    WHERE team_id = ${i.teamId} AND status IN ('creating', 'running')
                  ) < ${quota}
                  AND NOT EXISTS (
                    SELECT 1 FROM instances WHERE team_id = ${i.teamId} AND status IN ('creating', 'deleting')
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM instances
                    WHERE team_id = ${i.teamId} AND idx = ${i.index}
                      AND status != 'deleted'
                  )
                RETURNING ${columns}
              `
              if (rows.length > 0) {
                return yield* decodeInstance(rows[0])
              }

              const activeCountRows = yield* sql<{ activeCount: number }>`
                SELECT COUNT(*) AS activeCount FROM instances
                WHERE team_id = ${i.teamId} AND status IN ('creating', 'running')
              `
              if (activeCountRows[0].activeCount >= quota) {
                return yield* Effect.fail(new QuotaExceeded({ teamId: i.teamId, quota }))
              }

              const inProgressRows = yield* sql<{ id: string }>`
                SELECT id FROM instances WHERE team_id = ${i.teamId} AND status IN ('creating', 'deleting')
              `
              if (inProgressRows.length > 0) {
                return yield* Effect.fail(new ProvisionInProgress({ teamId: i.teamId }))
              }

              return yield* Effect.fail(new DuplicateInstanceIndex({ teamId: i.teamId, index: i.index }))
            })
          )
        ),

      // requestDeleteInstance(削除ボタン)専用の原子的 guard 付き UPDATE
      // (Task 6 レビュー #B)。単一の UPDATE ... WHERE ... RETURNING 文で
      // (1) 対象行が running/failed であること、(2) 同じチームに(対象以外で)
      // creating/deleting の行が無いこと、を検証してから status を deleting
      // に更新する(TOCTOU 回避、createIfAllowed と同型)。listByTeam で
      // 読んでから update する二段階実装だと、二つの並行リクエストが両方
      // 読み取りを通過して両方 deleting へ書き込めてしまう(チームにつき進行中
      // は高々1件という不変条件違反)。0 行更新時は Option.none() を返し、
      // 呼び出し元(requestDeleteInstance)が再読み込みして原因(対象不在 /
      // 対象の状態が既に running/failed でない / 他行が進行中)を優先順位付けて
      // 判定する。
      beginDeletingIfAllowed: (instanceId: InstanceId, now: number) =>
        wrapSqlError(
          sql<InstanceRow>`
            UPDATE instances
            SET status = 'deleting', updated_at = ${now}
            WHERE id = ${instanceId}
              AND status IN ('running', 'failed')
              AND NOT EXISTS (
                SELECT 1 FROM instances i2
                WHERE i2.team_id = instances.team_id
                  AND i2.id <> ${instanceId}
                  AND i2.status IN ('creating', 'deleting')
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

      // saga(provisioning.ts)が各ステップ後に progress/status/errorMessage/
      // updatedAt を保存するための全量更新(id で 1 行を丸ごと置き換える)。
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

      // ワーカー(provisioner.ts)が 1 tick で拾う対象。creating/deleting の
      // うち最も古い(created_at 昇順、同値は id で決定的に)1 件を返す。
      // 注意(Task 4 レビュー M6): この SELECT は行ロック(SELECT ... FOR
      // UPDATE 相当)を取らない単純な読み取りであり、単一プロセス(ワーカーは
      // main.ts で 1 fiber のみ forkScoped する前提、provisioner.ts のコメント
      // 参照)がこの関数を直列に呼ぶことでのみ「同時 1 インスタンス」の排他が
      // 成立する。複数プロセスから並行に呼ばれると同じ行を同時に拾い得る
      // (SQLite はプロセス内シングルスレッドだが、この関数自体は競合防止を
      // 提供しない)。
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
