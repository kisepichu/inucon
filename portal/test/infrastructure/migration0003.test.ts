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

// Task 6 レビュー #G: 0002 の緩い部分ユニークインデックス(failed を対象外)
// + admin の createInstance(台帳取り込み、(team_id, idx) の重複判定なし)
// によって、0003 適用前の DB には同じ (team_id, idx) に deleted 以外の行が
// 複数存在しうる。この状態で素朴に「DROP INDEX → CREATE UNIQUE INDEX ...
// WHERE status != 'deleted'」を実行すると CREATE UNIQUE INDEX 自体が UNIQUE
// 制約違反で失敗し migration 全体がロールバックされる(= 起動不能)。0003 は
// CREATE UNIQUE INDEX の前に重複を整理してから索引を張るため、この事前状態
// があっても migration 自体は必ず成功することを検証する。
layer("migration 0003: 事前に (team_id, idx) が重複していても整理してから索引を張る", (it) => {
  it.effect("failed 行(重複側)が deleted に倒され、running 行は残り、索引作成も成功する", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migration0001
      yield* migration0002
      yield* insertTeam(sql, { id: "team-0003-reconcile", teamNumber: 43 })

      // 0002 までの状態(failed は部分ユニークインデックスの対象外)なので、
      // この 2 行はどちらも INSERT 時点では拒否されず共存できる。
      // running 側は updated_at を意図的に古くし(0)、failed 側を新しく
      // する(999999)ことで、「非 failed を failed より優先する」という
      // keep-priority が「新しい updated_at を優先する」より優先されることを
      // 同時に検証する。
      yield* sql`
        INSERT INTO instances (id, team_id, idx, vmid, private_ip, status, created_at, updated_at)
        VALUES ('inst-0003-running', 'team-0003-reconcile', 1, 4301, '10.100.43.11', 'running', 0, 0)
      `
      yield* sql`
        INSERT INTO instances (id, team_id, idx, vmid, private_ip, status, created_at, updated_at)
        VALUES ('inst-0003-failed', 'team-0003-reconcile', 1, 4301, '10.100.43.11', 'failed', 0, 999999)
      `

      const exit = yield* Effect.exit(migration0003)
      expect(exit._tag).toBe("Success")

      const rows = yield* sql<{ id: string; status: string }>`
        SELECT id, status FROM instances WHERE team_id = 'team-0003-reconcile' ORDER BY id
      `
      expect(rows).toStrictEqual([
        { id: "inst-0003-failed", status: "deleted" },
        { id: "inst-0003-running", status: "running" }
      ])

      // 索引が実際に作られ、機能していること(同じ idx への新規 INSERT が
      // running 行と衝突して拒否される)も確認する。
      const dupExit = yield* Effect.exit(
        sql`
          INSERT INTO instances (id, team_id, idx, vmid, private_ip, status, created_at, updated_at)
          VALUES ('inst-0003-newdup', 'team-0003-reconcile', 1, 4301, '10.100.43.12', 'creating', 100, 100)
        `
      )
      expect(dupExit._tag).toBe("Failure")
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
