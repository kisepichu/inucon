import { SqlClient } from "@effect/sql"
import { Data, Effect } from "effect"

// 0004 と同じ理由(migration ファイルは自己完結する必要がある)で
// MigrationDataError をこのファイル内で再定義する。
export class MigrationDataError extends Data.TaggedError("MigrationDataError")<{
  readonly message: string
}> {}

// Task 2: 全 scoped 子テーブル(teams / team_members / team_invites / instances /
// bench_jobs / bench_job_logs)を「contest_id NOT NULL + (team_id, contest_id) の
// 複合 FK + contest 内 unique」の新スキーマへ前方専用で再構築する。
//
// - legacy contest が 1 行だけあるとき: 全子行を legacyContestId で backfill する。
//   teams.desired_instance_count は「そのチームの非 deleted インスタンス数を
//   contest.instance_quota で cap」した値、bench_jobs.purpose は 'competition' で
//   埋める(第1回は本番実行のみだったため)。
// - 0 contest の fresh DB のとき: 子テーブルは全て空である必要があり、空の
//   新スキーマだけ作る。空でなければ MigrationDataError で中断する(孤児行を
//   backfill する contestId を決められない)。
// - 複数 contest は 0004 で既に MigrationDataError なので、ここで想定しない。
//
// vmid ユニーク(status != 'deleted' の部分ユニーク)は cross-contest でも
// 効かせる。0002 で自然と一意になっていた実績(vmidFor(teamNumber, index) は
// team_number ごとに区間を分ける)を DB でも強制することで、Task11 以後の
// contest 再作成が失敗中の vmid をうっかり再割当することを防ぐ。0003 と同じく
// index 作成前にデータ側の重複を fail-fast で検出する。
//
// SQLite の ALTER TABLE 制限で NOT NULL 列追加や複合 FK 追加ができないため、
// 0002/0003/0004 と同じく「_new テーブル作成 → INSERT ... SELECT →
// DROP → RENAME」で置き換える。依存関係の順(child → parent)を考慮し、
// FK を張るのに必要な親テーブルが先に完成している必要がある。
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // 0004 の後なので contests は 0 か 1 行のはず。0004 で 2 行以上は既に
  // MigrationDataError になっているため、ここでは追加チェックを設けない。
  const contestRows = yield* sql<{ id: string; instance_quota: number }>`
    SELECT id, instance_quota FROM contests
  `
  const legacyContestId = contestRows.length === 1 ? contestRows[0].id : null
  const legacyQuota = contestRows.length === 1 ? contestRows[0].instance_quota : 0

  // 0 contest の fresh DB を想定した安全網: 子行が残っていると新スキーマの
  // NOT NULL contest_id を埋められないので fail-fast する。
  if (legacyContestId === null) {
    for (const table of ["teams", "team_members", "team_invites", "instances", "bench_jobs", "bench_job_logs"]) {
      const [{ n }] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql.unsafe(table)}`
      if (n > 0) {
        yield* Effect.fail(
          new MigrationDataError({
            message:
              `migration 0005: contests が 0 行ですが ${table} に ${n} 行の孤児データがあります。` +
              `contest_id を決められないため中断します。手動で ${table} を空にするか contests に 1 行 backfill してから再実行してください。`
          })
        )
      }
    }
  }

  // 事前チェック: vmid ユニーク(status != 'deleted')に違反するデータが既に
  // あれば MigrationDataError で中断する(0003 の重複 index 事前チェックと同型)。
  const vmidDupes = yield* sql<{ vmid: number; count: number }>`
    SELECT vmid, COUNT(*) AS count FROM instances
    WHERE status != 'deleted'
    GROUP BY vmid HAVING COUNT(*) > 1
  `
  if (vmidDupes.length > 0) {
    const detail = vmidDupes.map((d) => `(vmid=${d.vmid}, count=${d.count})`).join(", ")
    yield* Effect.fail(
      new MigrationDataError({
        message:
          `migration 0005: 非 deleted な instances に vmid の重複があります: ${detail}。` +
          `idx_instances_vmid_active(status != 'deleted' の unique)を張れないため中断します。` +
          `Proxmox 側の実 VM 状態を確認したうえで、片方を deleted に落とすか vmid を修正してから再実行してください。`
      })
    )
  }

  // --- teams(親) ---
  yield* sql`
    CREATE TABLE teams_new (
      id TEXT NOT NULL,
      contest_id TEXT NOT NULL REFERENCES contests(id),
      name TEXT NOT NULL,
      team_number INTEGER NOT NULL CHECK (team_number BETWEEN 1 AND 254),
      desired_instance_count INTEGER NOT NULL CHECK (desired_instance_count >= 0),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (id, contest_id),
      UNIQUE (contest_id, team_number)
    )
  `

  if (legacyContestId !== null) {
    // desired_instance_count は「非 deleted な現インスタンス数を quota で cap」
    // で backfill する(仕様: legacy team ごとに実績を反映しつつ quota を超えない)。
    yield* sql`
      INSERT INTO teams_new (id, contest_id, name, team_number, desired_instance_count, created_at)
      SELECT
        t.id,
        ${legacyContestId},
        t.name,
        t.team_number,
        MIN(
          ${legacyQuota},
          (SELECT COUNT(*) FROM instances i WHERE i.team_id = t.id AND i.status != 'deleted')
        ),
        t.created_at
      FROM teams t
    `

    const [{ src }] = yield* sql<{ src: number }>`SELECT COUNT(*) AS src FROM teams`
    const [{ dst }] = yield* sql<{ dst: number }>`SELECT COUNT(*) AS dst FROM teams_new`
    if (src !== dst) {
      yield* Effect.fail(
        new MigrationDataError({
          message: `migration 0005: teams (${src}) と teams_new (${dst}) の行数が一致しません`
        })
      )
    }
  }

  // --- team_members ---
  yield* sql`
    CREATE TABLE team_members_new (
      contest_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id),
      PRIMARY KEY (contest_id, team_id, user_id),
      UNIQUE (contest_id, user_id),
      FOREIGN KEY (team_id, contest_id) REFERENCES teams_new(id, contest_id)
    )
  `

  if (legacyContestId !== null) {
    yield* sql`
      INSERT INTO team_members_new (contest_id, team_id, user_id)
      SELECT ${legacyContestId}, team_id, user_id FROM team_members
    `

    const [{ src }] = yield* sql<{ src: number }>`SELECT COUNT(*) AS src FROM team_members`
    const [{ dst }] = yield* sql<{ dst: number }>`SELECT COUNT(*) AS dst FROM team_members_new`
    if (src !== dst) {
      yield* Effect.fail(
        new MigrationDataError({
          message: `migration 0005: team_members (${src}) と team_members_new (${dst}) の行数が一致しません`
        })
      )
    }
  }

  // --- team_invites ---
  yield* sql`
    CREATE TABLE team_invites_new (
      contest_id TEXT NOT NULL,
      github_login TEXT NOT NULL,
      team_id TEXT NOT NULL,
      email TEXT NOT NULL,
      invited_at INTEGER NOT NULL,
      PRIMARY KEY (contest_id, github_login),
      FOREIGN KEY (team_id, contest_id) REFERENCES teams_new(id, contest_id)
    )
  `

  if (legacyContestId !== null) {
    yield* sql`
      INSERT INTO team_invites_new (contest_id, github_login, team_id, email, invited_at)
      SELECT ${legacyContestId}, github_login, team_id, email, invited_at FROM team_invites
    `

    const [{ src }] = yield* sql<{ src: number }>`SELECT COUNT(*) AS src FROM team_invites`
    const [{ dst }] = yield* sql<{ dst: number }>`SELECT COUNT(*) AS dst FROM team_invites_new`
    if (src !== dst) {
      yield* Effect.fail(
        new MigrationDataError({
          message: `migration 0005: team_invites (${src}) と team_invites_new (${dst}) の行数が一致しません`
        })
      )
    }
  }

  // --- instances ---
  yield* sql`
    CREATE TABLE instances_new (
      id TEXT PRIMARY KEY,
      contest_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      idx INTEGER NOT NULL CHECK (idx > 0),
      vmid INTEGER NOT NULL,
      private_ip TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('creating','running','deleting','deleted','failed')),
      progress TEXT NOT NULL DEFAULT '[]',
      error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (team_id, contest_id) REFERENCES teams_new(id, contest_id)
    )
  `

  if (legacyContestId !== null) {
    yield* sql`
      INSERT INTO instances_new
        (id, contest_id, team_id, idx, vmid, private_ip, status, progress, error_message, created_at, updated_at)
      SELECT id, ${legacyContestId}, team_id, idx, vmid, private_ip, status, progress, error_message, created_at, updated_at
      FROM instances
    `

    const [{ src }] = yield* sql<{ src: number }>`SELECT COUNT(*) AS src FROM instances`
    const [{ dst }] = yield* sql<{ dst: number }>`SELECT COUNT(*) AS dst FROM instances_new`
    if (src !== dst) {
      yield* Effect.fail(
        new MigrationDataError({
          message: `migration 0005: instances (${src}) と instances_new (${dst}) の行数が一致しません`
        })
      )
    }
  }

  // --- bench_jobs ---
  yield* sql`
    CREATE TABLE bench_jobs_new (
      id TEXT PRIMARY KEY,
      contest_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      target_ip TEXT NOT NULL,
      target_port INTEGER NOT NULL DEFAULT 80 CHECK (target_port BETWEEN 1 AND 65535),
      status TEXT NOT NULL CHECK (status IN ('queued','running','finished','canceled','failed')),
      purpose TEXT NOT NULL CHECK (purpose IN ('rehearsal','competition')),
      score INTEGER,
      passed INTEGER CHECK (passed IN (0, 1)),
      error_message TEXT,
      enqueued_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      last_progress_at INTEGER,
      FOREIGN KEY (team_id, contest_id) REFERENCES teams_new(id, contest_id)
    )
  `

  if (legacyContestId !== null) {
    // 第1回は本番実行のみ(rehearsal は無かった)ため purpose='competition'。
    yield* sql`
      INSERT INTO bench_jobs_new
        (id, contest_id, team_id, target_ip, target_port, status, purpose, score, passed, error_message,
         enqueued_at, started_at, finished_at, last_progress_at)
      SELECT
        id, ${legacyContestId}, team_id, target_ip, target_port, status, 'competition',
        score, passed, error_message, enqueued_at, started_at, finished_at, last_progress_at
      FROM bench_jobs
    `

    const [{ src }] = yield* sql<{ src: number }>`SELECT COUNT(*) AS src FROM bench_jobs`
    const [{ dst }] = yield* sql<{ dst: number }>`SELECT COUNT(*) AS dst FROM bench_jobs_new`
    if (src !== dst) {
      yield* Effect.fail(
        new MigrationDataError({
          message: `migration 0005: bench_jobs (${src}) と bench_jobs_new (${dst}) の行数が一致しません`
        })
      )
    }
  }

  // --- bench_job_logs ---
  yield* sql`
    CREATE TABLE bench_job_logs_new (
      job_id TEXT PRIMARY KEY REFERENCES bench_jobs_new(id),
      log TEXT NOT NULL DEFAULT ''
    )
  `

  if (legacyContestId !== null) {
    yield* sql`INSERT INTO bench_job_logs_new (job_id, log) SELECT job_id, log FROM bench_job_logs`

    const [{ src }] = yield* sql<{ src: number }>`SELECT COUNT(*) AS src FROM bench_job_logs`
    const [{ dst }] = yield* sql<{ dst: number }>`SELECT COUNT(*) AS dst FROM bench_job_logs_new`
    if (src !== dst) {
      yield* Effect.fail(
        new MigrationDataError({
          message: `migration 0005: bench_job_logs (${src}) と bench_job_logs_new (${dst}) の行数が一致しません`
        })
      )
    }
  }

  // 旧テーブル DROP → RENAME(child から順に。0002 の instances/contests 依存
  // 制約に合わせて子テーブルから消す)。
  yield* sql`DROP TABLE bench_job_logs`
  yield* sql`DROP TABLE bench_jobs`
  yield* sql`DROP INDEX idx_bench_jobs_status`.pipe(Effect.orElseSucceed(() => undefined))
  yield* sql`DROP INDEX idx_bench_jobs_team`.pipe(Effect.orElseSucceed(() => undefined))
  yield* sql`DROP INDEX idx_instances_team_idx_active`.pipe(Effect.orElseSucceed(() => undefined))
  yield* sql`DROP TABLE instances`
  yield* sql`DROP TABLE team_invites`
  yield* sql`DROP TABLE team_members`
  yield* sql`DROP TABLE teams`

  yield* sql`ALTER TABLE teams_new RENAME TO teams`
  yield* sql`ALTER TABLE team_members_new RENAME TO team_members`
  yield* sql`ALTER TABLE team_invites_new RENAME TO team_invites`
  yield* sql`ALTER TABLE instances_new RENAME TO instances`
  yield* sql`ALTER TABLE bench_jobs_new RENAME TO bench_jobs`
  yield* sql`ALTER TABLE bench_job_logs_new RENAME TO bench_job_logs`

  // 部分ユニークインデックス(0003 と同条件で「非 deleted」を対象とする)。
  // Task 2/3 レビュー: 0004 の idx_instances_team_idx_active は
  // (team_id, idx) だけを対象にしていた。teams の PK は (id, contest_id)
  // で「id」単独ユニークではないため、リポジトリ側の NOT EXISTS ガードが
  // contest_id を条件に含むのと非対称だった。idx にも contest_id を含めて
  // ガードと index 定義を一致させる(実 UUID は衝突しないので影響は表面化
  // していなかったが、DB 側の invariant を明示するために揃える)。
  yield* sql`
    CREATE UNIQUE INDEX idx_instances_team_idx_active
    ON instances (contest_id, team_id, idx)
    WHERE status != 'deleted'
  `

  // cross-contest でも vmid の衝突を許さない(Task 2 レビュー: 別 edition で
  // 同じ vmid の VM を並行して掴まないことを DB で保証する)。
  yield* sql`
    CREATE UNIQUE INDEX idx_instances_vmid_active
    ON instances (vmid) WHERE status != 'deleted'
  `

  // 既存の bench_jobs インデックスを contest スコープに拡張して張り直す。
  yield* sql`CREATE INDEX idx_bench_jobs_status ON bench_jobs (contest_id, status, enqueued_at)`
  yield* sql`CREATE INDEX idx_bench_jobs_team ON bench_jobs (contest_id, team_id, enqueued_at DESC)`

  const fkViolations = yield* sql`PRAGMA foreign_key_check`
  if (fkViolations.length > 0) {
    yield* Effect.fail(
      new MigrationDataError({
        message: `migration 0005: foreign_key_check violations ${JSON.stringify(fkViolations)}`
      })
    )
  }
})
