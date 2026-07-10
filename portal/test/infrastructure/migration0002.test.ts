import { SqlClient } from "@effect/sql"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import migration0001 from "../../src/infrastructure/sql/migrations/0001_initial.js"
import migration0002 from "../../src/infrastructure/sql/migrations/0002_selfservice.js"
import { SqlTest } from "../support/sqlTest.js"

// このファイルは(sqlTest.ts の MigratorTest とは別に)0001 と 0002 を個別に
// 直接実行する。「0001 だけ適用した状態」を作ってから active 行を挿入し、
// そのあとで 0002 を適用する(brief の Step 3)ことを検証したいため、
// ディレクトリ丸ごと + 追跡テーブル付きの SqliteMigrator ではなく、
// マイグレーションファイルの default export(Effect)を直接呼ぶ。
//
// it.layer(...) は layer(名前, ...) の呼び出し単位で :memory: DB を
// 1個ビルドして(beforeAll)そのブロック内の it.effect 全部で共有する
// (repos.test.ts の BenchJobRepo 節と同じ注意点)。各シナリオは自分で
// migration0001/0002 を素の状態から適用するため、1 シナリオ = 1 個の
// layer(...) 呼び出しに分ける。
const layer = it.layer(SqlTest)

const insertTeam = (sql: SqlClient.SqlClient, args: { id: string; teamNumber: number }) =>
  sql`INSERT INTO teams (id, name, team_number, created_at) VALUES (${args.id}, ${"Team " + args.teamNumber}, ${args.teamNumber}, 0)`

const insertLegacyActiveInstance = (
  sql: SqlClient.SqlClient,
  args: { id: string; teamId: string; idx: number; privateIp: string }
) =>
  sql`
    INSERT INTO instances (id, team_id, idx, private_ip, status, created_at)
    VALUES (${args.id}, ${args.teamId}, ${args.idx}, ${args.privateIp}, 'active', 1000)
  `

layer("migration 0002: 既存 active 行の移行", (it) => {
  it.effect("0001 で active 行を入れてから 0002 を適用すると running へ移行し新カラムが埋まる", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migration0001

      yield* insertTeam(sql, { id: "team-1", teamNumber: 1 })
      yield* insertLegacyActiveInstance(sql, {
        id: "inst-1",
        teamId: "team-1",
        idx: 1,
        privateIp: "10.100.1.11"
      })

      yield* migration0002

      const rows = yield* sql<{
        id: string
        status: string
        vmid: number
        errorMessage: string | null
        progress: string
        createdAt: number
        updatedAt: number
      }>`
        SELECT id, status, vmid, error_message AS errorMessage, progress,
               created_at AS createdAt, updated_at AS updatedAt
        FROM instances WHERE id = 'inst-1'
      `
      expect(rows).toHaveLength(1)
      const row = rows[0]
      expect(row.status).toBe("running")
      // vmidFor(teamNumber=1, idx=1) = 1000 + 1*100 + 1 = 1101(実績: team1-1)
      expect(row.vmid).toBe(1101)
      expect(row.errorMessage).toBeNull()
      expect(JSON.parse(row.progress)).toStrictEqual([
        "clone_done",
        "configured",
        "started",
        "route_done",
        "access_done"
      ])
      expect(row.createdAt).toBe(1000)
      expect(row.updatedAt).toBe(1000)
    })
  )
})

layer("migration 0002: fail-fast(孤立 instances 行の安全網)", (it) => {
  it.effect("teams に無い team_id を持つ孤立行があると 0002 は失敗し instances は元のまま残る", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migration0001

      yield* insertTeam(sql, { id: "team-orphan-ok", teamNumber: 30 })
      yield* insertLegacyActiveInstance(sql, {
        id: "inst-ok",
        teamId: "team-orphan-ok",
        idx: 1,
        privateIp: "10.100.30.11"
      })
      // teams に存在しない team_id を持つ孤立行(INNER JOIN では drop される)。
      // instances.team_id は REFERENCES teams(id) かつ better-sqlite3 は
      // foreign_keys が既定 ON のため、通常の INSERT では作れない(過去の
      // データ不整合や手動修復スクリプトなど FK 検査が外れていた状況を模す
      // ため、この行の挿入だけ一時的に FK 検査を OFF にする)。
      yield* sql`PRAGMA foreign_keys = OFF`
      yield* insertLegacyActiveInstance(sql, {
        id: "inst-orphan",
        teamId: "team-does-not-exist",
        idx: 1,
        privateIp: "10.100.99.11"
      })
      yield* sql`PRAGMA foreign_keys = ON`

      // Migrator 本体は各 migration を withTransaction で包む
      // (@effect/sql の Migrator.js)。それを模して 0002 をトランザクション内で
      // 実行し、fail-fast のロールバックが機能することを確認する。
      const exit = yield* Effect.exit(sql.withTransaction(migration0002))
      expect(exit._tag).toBe("Failure")

      // ロールバックにより instances は 0001 のスキーマ・行のまま残る
      // (instances_new も DROP TABLE も実行されていない)。
      const rows = yield* sql<{ id: string; status: string }>`
        SELECT id, status FROM instances ORDER BY id
      `
      expect(rows.map((r) => r.id)).toStrictEqual(["inst-ok", "inst-orphan"])
      expect(rows.every((r) => r.status === "active")).toBe(true)
    })
  )
})

layer("migration 0002: 新規カラム/テーブル", (it) => {
  it.effect("contests.instance_quota / users.email / team_invites が作られる", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migration0001
      yield* migration0002

      yield* sql`INSERT INTO contests (id, name, problem_key, status) VALUES ('c1', 'C', 'p', 'preparing')`
      const contests = yield* sql<{ instanceQuota: number }>`
        SELECT instance_quota AS instanceQuota FROM contests WHERE id = 'c1'
      `
      expect(contests[0].instanceQuota).toBe(3)

      yield* sql`
        INSERT INTO users (id, github_id, github_login, display_name, is_admin, created_at)
        VALUES ('u1', 1, 'octocat', 'Octo', 0, 0)
      `
      const users = yield* sql<{ email: string | null }>`SELECT email FROM users WHERE id = 'u1'`
      expect(users[0].email).toBeNull()

      yield* insertTeam(sql, { id: "team-invite", teamNumber: 9 })
      yield* sql`
        INSERT INTO team_invites (github_login, team_id, email, invited_at)
        VALUES ('newbie', 'team-invite', 'newbie@example.com', 2000)
      `
      const invites = yield* sql<{ githubLogin: string; email: string }>`
        SELECT github_login AS githubLogin, email FROM team_invites WHERE github_login = 'newbie'
      `
      expect(invites).toHaveLength(1)
      expect(invites[0].email).toBe("newbie@example.com")
    })
  )
})

layer("migration 0002: status CHECK", (it) => {
  it.effect("新集合のみ許可される('active' は拒否される)", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migration0001
      yield* migration0002
      yield* insertTeam(sql, { id: "team-check", teamNumber: 10 })

      const exit = yield* Effect.exit(
        sql`
          INSERT INTO instances (id, team_id, idx, vmid, private_ip, status, created_at, updated_at)
          VALUES ('inst-bad', 'team-check', 1, 1101, '10.100.10.11', 'active', 0, 0)
        `
      )
      expect(exit._tag).toBe("Failure")
    })
  )
})

layer("migration 0002: 部分ユニークインデックス(deleted 行があっても再作成可)", (it) => {
  it.effect("同 idx でも deleted 行があれば新規作成できる", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migration0001
      yield* migration0002
      yield* insertTeam(sql, { id: "team-reuse", teamNumber: 20 })

      yield* sql`
        INSERT INTO instances (id, team_id, idx, vmid, private_ip, status, created_at, updated_at)
        VALUES ('inst-old', 'team-reuse', 1, 2001, '10.100.20.11', 'deleted', 0, 0)
      `

      const exit = yield* Effect.exit(
        sql`
          INSERT INTO instances (id, team_id, idx, vmid, private_ip, status, created_at, updated_at)
          VALUES ('inst-new', 'team-reuse', 1, 2001, '10.100.20.11', 'running', 100, 100)
        `
      )
      expect(exit._tag).toBe("Success")

      const rows = yield* sql`SELECT id, status FROM instances WHERE team_id = 'team-reuse' ORDER BY id`
      expect(rows).toHaveLength(2)
    })
  )
})

layer("migration 0002: 部分ユニークインデックス(進行中の重複は拒否)", (it) => {
  it.effect("creating 中の同 idx は重複拒否される", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migration0001
      yield* migration0002
      yield* insertTeam(sql, { id: "team-dup", teamNumber: 21 })

      yield* sql`
        INSERT INTO instances (id, team_id, idx, vmid, private_ip, status, created_at, updated_at)
        VALUES ('inst-a', 'team-dup', 1, 2101, '10.100.21.11', 'creating', 0, 0)
      `

      const exit = yield* Effect.exit(
        sql`
          INSERT INTO instances (id, team_id, idx, vmid, private_ip, status, created_at, updated_at)
          VALUES ('inst-b', 'team-dup', 1, 2101, '10.100.21.11', 'running', 100, 100)
        `
      )
      expect(exit._tag).toBe("Failure")
    })
  )
})

layer("migration 0002: 部分ユニークインデックス(failed 行があっても再作成可)", (it) => {
  it.effect("failed 行がある idx にも creating を新規作成できる", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migration0001
      yield* migration0002
      yield* insertTeam(sql, { id: "team-failed-reuse", teamNumber: 22 })

      yield* sql`
        INSERT INTO instances (id, team_id, idx, vmid, private_ip, status, created_at, updated_at)
        VALUES ('inst-failed', 'team-failed-reuse', 1, 2201, '10.100.22.11', 'failed', 0, 0)
      `

      const exit = yield* Effect.exit(
        sql`
          INSERT INTO instances (id, team_id, idx, vmid, private_ip, status, created_at, updated_at)
          VALUES ('inst-retry', 'team-failed-reuse', 1, 2201, '10.100.22.11', 'creating', 100, 100)
        `
      )
      expect(exit._tag).toBe("Success")
    })
  )
})
