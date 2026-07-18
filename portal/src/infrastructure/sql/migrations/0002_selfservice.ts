import { SqlClient } from "@effect/sql"
import { Data, Effect } from "effect"

// 移行時のデータ不整合(想定されるエラー)。defect ではなく通常の failure に
// することで、Migrator のエラー分類・ログで移行失敗として扱いやすくする。
export class MigrationDataError extends Data.TaggedError("MigrationDataError")<{
  readonly message: string
}> {}

// 本番 DB(apphost)が既に稼働中のため 0001 は変更しない(前方専用)。
//
// instances は「UNIQUE(team_id, idx)」を「status IN ('creating','running',
// 'deleting') の部分ユニークインデックス」に置き換える必要があるが、SQLite は
// 既存テーブルの UNIQUE 制約を ALTER TABLE で外せない。そのため SQLite 公式の
// 推奨手順(https://www.sqlite.org/lang_altertable.html#otheralter)に従い、
// 新テーブルを作成 → データを移行(既存 active 行は running に読み替え、
// teams と JOIN して vmid を実績どおり計算)→ 旧テーブルを DROP →
// リネームする。
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // --- instances: 状態機械の拡張 + 部分ユニークインデックス化 ---
  yield* sql`
    CREATE TABLE instances_new (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id),
      idx INTEGER NOT NULL CHECK (idx > 0),
      vmid INTEGER NOT NULL,
      private_ip TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('creating','running','deleting','deleted','failed')),
      progress TEXT NOT NULL DEFAULT '[]',
      error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `

  // 既存 active 行(Phase 2)を running に読み替えつつ移行する。vmid は
  // instance.ts の vmidFor(teamNumber, idx) = 1000 + teamNumber*100 + idx を
  // teams との JOIN で計算する(実績: team1-1 = 1101)。progress は「既に
  // 稼働中の実績」として全ステップ完了済みで埋める(監査用の記録であり、
  // saga が再実行することはない)。updated_at は移行時点のデータが無いため
  // created_at を流用する。
  yield* sql`
    INSERT INTO instances_new (id, team_id, idx, vmid, private_ip, status, progress, error_message, created_at, updated_at)
    SELECT
      i.id,
      i.team_id,
      i.idx,
      1000 + t.team_number * 100 + i.idx,
      i.private_ip,
      CASE i.status WHEN 'active' THEN 'running' ELSE i.status END,
      '["clone_done","configured","started","route_done","access_done"]',
      NULL,
      i.created_at,
      i.created_at
    FROM instances i
    JOIN teams t ON t.id = i.team_id
  `

  // fail-fast: INNER JOIN は teams に存在しない team_id を持つ孤立行を
  // silently drop する。Migrator は各 migration を withTransaction で包む
  // (@effect/sql の SqliteMigrator)ため、ここで行数不一致を検出して例外を
  // 投げれば移行全体がロールバックされ、instances は元のまま残る(本番
  // データを黙って失う事故を防ぐ安全網)。
  const [{ sourceCount }] = yield* sql<{ sourceCount: number }>`SELECT COUNT(*) AS sourceCount FROM instances`
  const [{ migratedCount }] = yield* sql<{
    migratedCount: number
  }>`SELECT COUNT(*) AS migratedCount FROM instances_new`
  if (sourceCount !== migratedCount) {
    yield* Effect.fail(
      new MigrationDataError({
        message:
          `migration 0002: instances (${sourceCount} 行) と instances_new (${migratedCount} 行) の行数が一致しません。` +
          `teams に存在しない team_id を持つ孤立 instances 行が INNER JOIN で移行されなかった可能性があります。` +
          `SELECT * FROM instances WHERE team_id NOT IN (SELECT id FROM teams) で調査してください。`
      })
    )
  }

  yield* sql`DROP TABLE instances`
  yield* sql`ALTER TABLE instances_new RENAME TO instances`

  // 「進行中/稼働中」に限定した部分ユニークインデックス。deleted/failed の
  // 行が残っていても同じ (team_id, idx) で再作成できる(スペック §Instance
  // 集約: 削除対象の index 再利用は deleted/failed の行があっても可)。
  //
  // 【2026-07 追記】failed を対象外にする上の判断は Task 6 レビュー #E で
  // 覆された(failed 行はまだ vmid/VM を握っているため、アプリ層の
  // allocator と同様に (team_id, idx) を予約すべき)。0002 は本番適用済みの
  // forward-only migration のため述語はここでは変更せず、0003 で
  // DROP INDEX → 再作成して「status != 'deleted'」に締め直している。
  yield* sql`
    CREATE UNIQUE INDEX idx_instances_team_idx_active
    ON instances (team_id, idx)
    WHERE status IN ('creating', 'running', 'deleting')
  `

  // --- contests: チームごとのインスタンス上限(既定 3) ---
  yield* sql`ALTER TABLE contests ADD COLUMN instance_quota INTEGER NOT NULL DEFAULT 3`

  // --- users: Access(Cloudflare)ログイン用メール。admin が招待時に入力する
  // (GitHub からの自動取得はしない、スペック §招待フロー)。既存行は NULL。
  yield* sql`ALTER TABLE users ADD COLUMN email TEXT`

  // --- team_invites: 未ログインユーザーへの事前招待(初回ログインで消費) ---
  yield* sql`
    CREATE TABLE team_invites (
      github_login TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id),
      email TEXT NOT NULL,
      invited_at INTEGER NOT NULL
    )
  `
})
