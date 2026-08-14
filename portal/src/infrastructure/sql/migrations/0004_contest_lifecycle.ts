import { SqlClient } from "@effect/sql"
import { Data, Effect } from "effect"

// migration 0002/0003 と同じ理由(Migrator の動的 import では相対 import の
// 拡張子解決が効かない)で、共通 MigrationDataError を import せずこのファイル
// 内で同じ _tag のエラー型を再定義する。
export class MigrationDataError extends Data.TaggedError("MigrationDataError")<{
  readonly message: string
}> {}

// Task 1 (multi-edition lifecycle): contests テーブルだけを Task1 の完全な形へ
// 前方専用で再構築する。
//
// - status に draft/finalizing/canceled を追加(既存 preparing/running/finished は
//   そのまま保持される)。
// - edition/problem_revision/template_vmid を必須列として追加、既存 1 行(第1回
//   INUCON)は edition=1 / template_vmid=9100 / problem_revision='legacy-2026-07-08'
//   に backfill する。
// - schedule (scheduled_start_at, scheduled_end_at, access_closes_at, cleanup_at)、
//   closed timestamps (access_closed_at, cleanup_completed_at)、状態遷移時刻
//   (started_at, finalizing_at, finished_at, canceled_at) はすべて nullable。
//   Phase-2 の legacy 行はどれも scheduler の管理下になかったので、closed
//   timestamps を back-fill せず null のまま残す(scheduler の due 述語
//   accessClosesAt <= now AND accessClosedAt IS NULL は accessClosesAt=NULL の
//   時点で偽になるため、Task12 の revoke_access は edition1 を触らない)。
// - revision は既存行を 1 で backfill、以後の mutation で +1。
// - unique 制約は edition が status != 'canceled' で partial、preparing/running/
//   finalizing が全 contests で最大 1 行の partial index。canceled が edition
//   番号を消費しないことで、canceled のあとに同じ edition の draft を作り直せる。
//
// SQLite の ALTER TABLE 制限(CHECK 変更・複合 UNIQUE 追加不可)により、
// 公式推奨手順 (https://www.sqlite.org/lang_altertable.html#otheralter) に従い
// contests_new を作成 → データ移行 → 旧 contests を DROP → RENAME する。
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // 事前チェック: legacy 期(Phase 2 = 0001-0003 適用済み)は contests が
  // 0 か 1 行のはず。想定を超える行数が入っているとき自動 backfill は危険
  // (どれを edition=1 にするか決められない)なので MigrationDataError で
  // 中断する(0002/0003 の fail-fast と同じ流儀)。
  const [{ legacyContestCount }] = yield* sql<{ legacyContestCount: number }>`
    SELECT COUNT(*) AS legacyContestCount FROM contests
  `
  if (legacyContestCount > 1) {
    yield* Effect.fail(
      new MigrationDataError({
        message:
          `migration 0004: contests に ${legacyContestCount} 行あります。legacy backfill は 0 か 1 行を前提にしています。` +
          `どの行を edition=1 として backfill するか判断できないため、手動で 1 行に整理してから migration を再実行してください。`
      })
    )
  }

  yield* sql`
    CREATE TABLE contests_new (
      id TEXT PRIMARY KEY,
      edition INTEGER NOT NULL CHECK (edition > 0),
      name TEXT NOT NULL,
      problem_key TEXT NOT NULL,
      problem_revision TEXT NOT NULL,
      template_vmid INTEGER NOT NULL CHECK (template_vmid > 0),
      status TEXT NOT NULL CHECK (status IN ('draft','preparing','running','finalizing','finished','canceled')),
      instance_quota INTEGER NOT NULL CHECK (instance_quota > 0),
      scheduled_start_at INTEGER,
      scheduled_end_at INTEGER,
      access_closes_at INTEGER,
      cleanup_at INTEGER,
      access_closed_at INTEGER,
      cleanup_completed_at INTEGER,
      started_at INTEGER,
      finalizing_at INTEGER,
      finished_at INTEGER,
      canceled_at INTEGER,
      revision INTEGER NOT NULL CHECK (revision > 0)
    )
  `

  // legacy 1 行を backfill する。0002 の contests は
  // (id, name, problem_key, status, instance_quota) しか持たない。
  // 「第1回 INUCON」の運用実績を編集回1/template9100/problem_revision=legacy-...
  // として復元する(スペック §「開催回スコープ導入と履歴保持」)。
  yield* sql`
    INSERT INTO contests_new (
      id, edition, name, problem_key, problem_revision, template_vmid,
      status, instance_quota,
      scheduled_start_at, scheduled_end_at, access_closes_at, cleanup_at,
      access_closed_at, cleanup_completed_at,
      started_at, finalizing_at, finished_at, canceled_at,
      revision
    )
    SELECT
      id, 1, name, problem_key, 'legacy-2026-07-08', 9100,
      status, instance_quota,
      NULL, NULL, NULL, NULL,
      NULL, NULL,
      NULL, NULL, NULL, NULL,
      1
    FROM contests
  `

  // 移行後の整合性チェック: 旧 contests と contests_new は同じ行数のはず。
  // 0002 の孤立 instances 検出と同じ fail-fast パターン。
  const [{ sourceCount }] = yield* sql<{ sourceCount: number }>`SELECT COUNT(*) AS sourceCount FROM contests`
  const [{ migratedCount }] = yield* sql<{
    migratedCount: number
  }>`SELECT COUNT(*) AS migratedCount FROM contests_new`
  if (sourceCount !== migratedCount) {
    yield* Effect.fail(
      new MigrationDataError({
        message:
          `migration 0004: contests (${sourceCount} 行) と contests_new (${migratedCount} 行) の行数が一致しません。`
      })
    )
  }

  yield* sql`DROP TABLE contests`
  yield* sql`ALTER TABLE contests_new RENAME TO contests`

  // edition の unique は canceled を除外した partial index。canceled edition N を
  // 作り直したいとき、番号を再利用できるようにする(spec §「開催回番号の再発行」)。
  yield* sql`
    CREATE UNIQUE INDEX idx_contests_edition_live
    ON contests (edition) WHERE status != 'canceled'
  `

  // preparing/running/finalizing の Contest は全体で最大 1 行(spec §「同時に
  // 進行中の Contest は 1 つ」)。partial unique index の式には定数(1)を使う。
  yield* sql`
    CREATE UNIQUE INDEX idx_contests_single_operational
    ON contests ((1)) WHERE status IN ('preparing', 'running', 'finalizing')
  `

  // Migrator は各 migration を withTransaction で包むため、FK 検査もここで
  // 走らせておく(以後の Task で child が contests を参照するので健全性の担保)。
  const fkViolations = yield* sql`PRAGMA foreign_key_check`
  if (fkViolations.length > 0) {
    yield* Effect.fail(
      new MigrationDataError({
        message: `migration 0004: foreign_key_check violations ${JSON.stringify(fkViolations)}`
      })
    )
  }
})
