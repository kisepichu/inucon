import { SqlClient } from "@effect/sql"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import migration0001 from "../../src/infrastructure/sql/migrations/0001_initial.js"
import migration0002 from "../../src/infrastructure/sql/migrations/0002_selfservice.js"
import migration0003 from "../../src/infrastructure/sql/migrations/0003_failed_reserves_slot.js"
import { SqlTest } from "../support/sqlTest.js"

// migration0002.test.ts と同じ方針(brief 参照): ディレクトリ丸ごとの
// SqliteMigrator ではなく、各 migration の default export(Effect)を直接
// 順番に適用して「0003 適用後の最終状態」だけを狙い撃ちで検証する。
//
// Task 6 レビュー #E: 0002 の部分ユニークインデックス
// idx_instances_team_idx_active は status IN ('creating','running','deleting')
// で failed を対象外にしていたため、failed 行(まだ vmid/VM を握っている)と
// running 行が同じ (team_id, idx) で共存できてしまっていた。0003 は
// DROP INDEX → CREATE UNIQUE INDEX ... WHERE status != 'deleted' で
// failed も予約対象に含める。
const layer = it.layer(SqlTest)

const insertTeam = (sql: SqlClient.SqlClient, args: { id: string; teamNumber: number }) =>
  sql`INSERT INTO teams (id, name, team_number, created_at) VALUES (${args.id}, ${"Team " + args.teamNumber}, ${args.teamNumber}, 0)`

// migration0002.test.ts と同じ注意点(it.layer(...) は layer(名前, ...) の
// 呼び出し単位で :memory: DB を1個ビルドしてブロック内の it.effect 全部で
// 共有する)のため、各シナリオが自分で migration0001 から素の状態を作る
// 以上、1 シナリオ = 1 個の layer(...) 呼び出しに分ける。

layer("migration 0003: failed 行がある idx への新規 INSERT は拒否される", (it) => {
  it.effect("UNIQUE 制約違反になる", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migration0001
      yield* migration0002
      yield* migration0003
      yield* insertTeam(sql, { id: "team-0003-dup", teamNumber: 40 })

      yield* sql`
        INSERT INTO instances (id, team_id, idx, vmid, private_ip, status, created_at, updated_at)
        VALUES ('inst-0003-failed', 'team-0003-dup', 1, 4001, '10.100.40.11', 'failed', 0, 0)
      `

      const exit = yield* Effect.exit(
        sql`
          INSERT INTO instances (id, team_id, idx, vmid, private_ip, status, created_at, updated_at)
          VALUES ('inst-0003-new', 'team-0003-dup', 1, 4001, '10.100.40.11', 'running', 100, 100)
        `
      )
      expect(exit._tag).toBe("Failure")

      const rows = yield* sql`SELECT id FROM instances WHERE team_id = 'team-0003-dup'`
      expect(rows).toHaveLength(1)
    })
  )
})

layer("migration 0003: failed 行の通常の自己サービス削除経路は壊れない", (it) => {
  it.effect("他行と衝突が無ければ、同じ行をそのまま deleting へ UPDATE できる", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migration0001
      yield* migration0002
      yield* migration0003
      yield* insertTeam(sql, { id: "team-0003-selfupdate", teamNumber: 41 })

      yield* sql`
        INSERT INTO instances (id, team_id, idx, vmid, private_ip, status, created_at, updated_at)
        VALUES ('inst-0003-selfupdate', 'team-0003-selfupdate', 1, 4101, '10.100.41.11', 'failed', 0, 0)
      `

      // 同じ行を書き換えるだけなので、部分ユニークインデックスが failed を
      // 対象に含めていても自己衝突にはならず成功する。
      const exit = yield* Effect.exit(
        sql`
          UPDATE instances SET status = 'deleting', updated_at = 200
          WHERE id = 'inst-0003-selfupdate'
        `
      )
      expect(exit._tag).toBe("Success")

      const rows = yield* sql<{ status: string }>`
        SELECT status FROM instances WHERE id = 'inst-0003-selfupdate'
      `
      expect(rows[0].status).toBe("deleting")
    })
  )
})

layer("migration 0003: deleted 行がある idx は再作成できる", (it) => {
  it.effect("0003 適用後も deleted は部分ユニークインデックスの対象外", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migration0001
      yield* migration0002
      yield* migration0003
      yield* insertTeam(sql, { id: "team-0003-deleted-reuse", teamNumber: 42 })

      yield* sql`
        INSERT INTO instances (id, team_id, idx, vmid, private_ip, status, created_at, updated_at)
        VALUES ('inst-0003-old', 'team-0003-deleted-reuse', 1, 4201, '10.100.42.11', 'deleted', 0, 0)
      `

      const exit = yield* Effect.exit(
        sql`
          INSERT INTO instances (id, team_id, idx, vmid, private_ip, status, created_at, updated_at)
          VALUES ('inst-0003-fresh', 'team-0003-deleted-reuse', 1, 4201, '10.100.42.11', 'running', 100, 100)
        `
      )
      expect(exit._tag).toBe("Success")

      const rows = yield* sql`SELECT id FROM instances WHERE team_id = 'team-0003-deleted-reuse' ORDER BY id`
      expect(rows).toHaveLength(2)
    })
  )
})
