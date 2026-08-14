import { SqlClient } from "@effect/sql"
import { it } from "@effect/vitest"
import { Cause, Effect, Option } from "effect"
import { expect } from "vitest"
import migration0001 from "../../src/infrastructure/sql/migrations/0001_initial.js"
import migration0002 from "../../src/infrastructure/sql/migrations/0002_selfservice.js"
import migration0003 from "../../src/infrastructure/sql/migrations/0003_failed_reserves_slot.js"
import migration0004 from "../../src/infrastructure/sql/migrations/0004_contest_lifecycle.js"
import migration0005 from "../../src/infrastructure/sql/migrations/0005_multi_contest.js"
import { SqlTest } from "../support/sqlTest.js"

// migration0002/0003/0004.test.ts と同じ方針(brief 参照): 各 migration の
// default export(Effect)を直接順番に適用して「0005 適用後の最終状態」だけを
// 狙い撃ちで検証する。0005 は Team/TeamMember/TeamInvite/Instance/BenchJob/
// BenchJobLog の全てに contest_id NOT NULL を付与し、
// (team_id, contest_id) の複合 FK と scoped unique を張り、
// idx_instances_vmid_active(status != 'deleted' の vmid ユニーク)を追加する。
// 既存 legacy contest 1 行の子行はその contestId を backfill、bench_jobs は
// purpose='competition' で埋める、teams.desired_instance_count は当該チームの
// 非 deleted インスタンス数(quota 上限で cap)で埋める。

const legacyContestId = "contest-legacy-1"

const seedPhase2 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* migration0001
  yield* migration0002
  yield* migration0003

  yield* sql`
    INSERT INTO contests (id, name, problem_key, status, instance_quota)
    VALUES (${legacyContestId}, 'INUCON', 'private-isu', 'finished', 3)
  `
})

const seedLegacyChildren = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // teams(2 チーム)
  yield* sql`INSERT INTO teams (id, name, team_number, created_at) VALUES ('t-1', 'Team 1', 1, 0)`
  yield* sql`INSERT INTO teams (id, name, team_number, created_at) VALUES ('t-2', 'Team 2', 2, 0)`

  // users + team_members(2 メンバー)
  yield* sql`INSERT INTO users (id, github_id, github_login, display_name, is_admin, created_at, email) VALUES ('u-1', 1, 'alice', 'Alice', 0, 0, 'a@example.com')`
  yield* sql`INSERT INTO users (id, github_id, github_login, display_name, is_admin, created_at, email) VALUES ('u-2', 2, 'bob', 'Bob', 0, 0, 'b@example.com')`
  yield* sql`INSERT INTO team_members (team_id, user_id) VALUES ('t-1', 'u-1')`
  yield* sql`INSERT INTO team_members (team_id, user_id) VALUES ('t-2', 'u-2')`

  // team_invites(1 招待)
  yield* sql`INSERT INTO team_invites (github_login, team_id, email, invited_at) VALUES ('carol', 't-1', 'c@example.com', 0)`

  // instances(1 running)
  yield* sql`
    INSERT INTO instances (id, team_id, idx, vmid, private_ip, status, progress, error_message, created_at, updated_at)
    VALUES ('inst-1', 't-1', 1, 1101, '10.100.1.11',
      'running', '["clone_done","configured","started","route_done","access_done"]', NULL, 0, 0)
  `

  // bench_jobs(1 finished + 1 failed) + logs
  yield* sql`
    INSERT INTO bench_jobs (id, team_id, target_ip, target_port, status, score, passed, error_message, enqueued_at, started_at, finished_at, last_progress_at)
    VALUES ('job-fin', 't-1', '10.100.1.11', 80, 'finished', 1077, 1, NULL, 100, 100, 200, 200)
  `
  yield* sql`
    INSERT INTO bench_jobs (id, team_id, target_ip, target_port, status, score, passed, error_message, enqueued_at, started_at, finished_at, last_progress_at)
    VALUES ('job-fail', 't-2', '10.100.2.11', 80, 'failed', NULL, NULL, 'boom', 300, 300, 400, 400)
  `
  yield* sql`INSERT INTO bench_job_logs (job_id, log) VALUES ('job-fin', 'ok')`
  yield* sql`INSERT INTO bench_job_logs (job_id, log) VALUES ('job-fail', 'err')`
})

it.layer(SqlTest)(
  "migration 0005: legacy 1 contest の子テーブルに contestId を backfill する",
  (it) => {
    it.effect("teams/team_members/team_invites/instances/bench_jobs すべてが legacyContestId で埋まる", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* seedPhase2
        yield* seedLegacyChildren
        yield* migration0004
        yield* migration0005

        // 行数保存
        const [{ n: teamsCount }] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM teams`
        expect(teamsCount).toBe(2)
        const [{ n: instancesCount }] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM instances`
        expect(instancesCount).toBe(1)
        const [{ n: jobsCount }] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM bench_jobs`
        expect(jobsCount).toBe(2)

        // contestId が全 backfill されている
        const [{ n: teamsWrong }] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM teams WHERE contest_id != ${legacyContestId}`
        expect(teamsWrong).toBe(0)
        const [{ n: membersWrong }] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM team_members WHERE contest_id != ${legacyContestId}`
        expect(membersWrong).toBe(0)
        const [{ n: invitesWrong }] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM team_invites WHERE contest_id != ${legacyContestId}`
        expect(invitesWrong).toBe(0)
        const [{ n: instancesWrong }] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM instances WHERE contest_id != ${legacyContestId}`
        expect(instancesWrong).toBe(0)
        const [{ n: jobsWrong }] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM bench_jobs WHERE contest_id != ${legacyContestId}`
        expect(jobsWrong).toBe(0)

        // teams.desired_instance_count は非 deleted インスタンス数を quota で cap
        const teamRows = yield* sql<{ id: string; desired: number }>`
          SELECT id, desired_instance_count AS desired FROM teams ORDER BY team_number
        `
        expect(teamRows).toEqual([
          { id: "t-1", desired: 1 },
          { id: "t-2", desired: 0 }
        ])

        // bench_jobs.purpose は 'competition'
        const jobRows = yield* sql<{ id: string; purpose: string }>`
          SELECT id, purpose FROM bench_jobs ORDER BY id
        `
        expect(jobRows).toEqual([
          { id: "job-fail", purpose: "competition" },
          { id: "job-fin", purpose: "competition" }
        ])

        // FK 整合性
        const fk = yield* sql`PRAGMA foreign_key_check`
        expect(fk).toEqual([])

        // contests 側は 0004 で backfill 済みの 1 行のまま
        const contests = yield* sql<{ id: string; edition: number; templateVmid: number; problem_revision: string; status: string }>`
          SELECT id, edition, template_vmid AS templateVmid, problem_revision, status FROM contests
        `
        expect(contests).toEqual([
          { id: legacyContestId, edition: 1, templateVmid: 9100, problem_revision: "legacy-2026-07-08", status: "finished" }
        ])
      })
    )
  }
)

it.layer(SqlTest)(
  "migration 0005: 同じ user は別 contest で複数チームに所属できるが同一 contest 内は 1 チームまで",
  (it) => {
    it.effect("scoped unique が (contest_id, user_id) を強制する", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* seedPhase2
        yield* seedLegacyChildren
        yield* migration0004
        yield* migration0005

        // 別 contest を追加(edition 2)
        yield* sql`
          INSERT INTO contests (
            id, edition, name, problem_key, problem_revision, template_vmid,
            status, instance_quota, revision
          ) VALUES ('contest-2', 2, 'INUCON 2', 'private-isu', 'v2', 9100, 'draft', 3, 1)
        `
        // 別 contest のチーム(team_number は同じ 1 でも OK: scoped unique)
        yield* sql`
          INSERT INTO teams (id, contest_id, name, team_number, desired_instance_count, created_at)
          VALUES ('t-2-1', 'contest-2', 'Team 1', 1, 3, 0)
        `

        // u-1 を別 contest のチームに追加(同じ user が別 contest で参加できる)
        const okDifferent = yield* Effect.exit(
          sql`INSERT INTO team_members (contest_id, team_id, user_id) VALUES ('contest-2', 't-2-1', 'u-1')`
        )
        expect(okDifferent._tag).toBe("Success")

        // 同一 contest 内で u-1 を別チームに再追加は失敗
        yield* sql`
          INSERT INTO teams (id, contest_id, name, team_number, desired_instance_count, created_at)
          VALUES ('t-1-other', ${legacyContestId}, 'Team Other', 100, 3, 0)
        `
        const conflict = yield* Effect.exit(
          sql`INSERT INTO team_members (contest_id, team_id, user_id) VALUES (${legacyContestId}, 't-1-other', 'u-1')`
        )
        expect(conflict._tag).toBe("Failure")
      })
    )
  }
)

it.layer(SqlTest)(
  "migration 0005: 0 contests の fresh DB では空スキーマを構築する",
  (it) => {
    it.effect("空 DB から 0001-0005 を通すと contests は 0 行のまま", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* migration0001
        yield* migration0002
        yield* migration0003
        yield* migration0004
        yield* migration0005

        const [{ n }] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM contests`
        expect(n).toBe(0)

        // 新スキーマは contest_id 列を必ず持つ(NOT NULL 制約の存在確認)
        const teamCols = yield* sql<{ name: string; notnull: number }>`PRAGMA table_info(teams)`
        const contestIdTeamCol = teamCols.find((c) => c.name === "contest_id")
        expect(contestIdTeamCol).toBeDefined()
        expect(contestIdTeamCol?.notnull).toBe(1)

        const desiredCol = teamCols.find((c) => c.name === "desired_instance_count")
        expect(desiredCol).toBeDefined()

        const jobCols = yield* sql<{ name: string; notnull: number }>`PRAGMA table_info(bench_jobs)`
        expect(jobCols.find((c) => c.name === "contest_id")?.notnull).toBe(1)
        expect(jobCols.find((c) => c.name === "purpose")?.notnull).toBe(1)
      })
    )
  }
)

it.layer(SqlTest)(
  "migration 0005: vmid ユニーク(status != 'deleted')が cross-contest でも効く",
  (it) => {
    it.effect("同じ vmid の 2 つ目 non-deleted は idx_instances_vmid_active で拒否される", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* seedPhase2
        yield* seedLegacyChildren
        yield* migration0004
        yield* migration0005

        // 別 contest と別 team を用意
        yield* sql`
          INSERT INTO contests (
            id, edition, name, problem_key, problem_revision, template_vmid,
            status, instance_quota, revision
          ) VALUES ('contest-2', 2, 'INUCON 2', 'private-isu', 'v2', 9100, 'draft', 3, 1)
        `
        yield* sql`
          INSERT INTO teams (id, contest_id, name, team_number, desired_instance_count, created_at)
          VALUES ('t-2-1', 'contest-2', 'Team 1', 1, 3, 0)
        `

        // 既存 vmid=1101 に衝突する non-deleted 行を別 contest から挿入 → 拒否
        const conflict = yield* Effect.exit(
          sql`
            INSERT INTO instances (id, contest_id, team_id, idx, vmid, private_ip, status, progress, error_message, created_at, updated_at)
            VALUES ('inst-clash', 'contest-2', 't-2-1', 1, 1101, '10.100.1.11', 'creating', '[]', NULL, 500, 500)
          `
        )
        expect(conflict._tag).toBe("Failure")

        // 既存 vmid=1101 を deleted にすれば同じ vmid を再利用できる
        yield* sql`UPDATE instances SET status = 'deleted' WHERE id = 'inst-1'`
        const okAfterDelete = yield* Effect.exit(
          sql`
            INSERT INTO instances (id, contest_id, team_id, idx, vmid, private_ip, status, progress, error_message, created_at, updated_at)
            VALUES ('inst-clash2', 'contest-2', 't-2-1', 1, 1101, '10.100.1.11', 'creating', '[]', NULL, 600, 600)
          `
        )
        expect(okAfterDelete._tag).toBe("Success")
      })
    )
  }
)

it.layer(SqlTest)(
  "migration 0005: canceled edition は edition 番号を消費しない(0004 の partial unique 継続確認)",
  (it) => {
    it.effect("edition=1 が canceled でも新規 edition=1 の draft を作れる", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* migration0001
        yield* migration0002
        yield* migration0003
        yield* migration0004
        yield* migration0005

        // canceled な edition=1
        yield* sql`
          INSERT INTO contests (
            id, edition, name, problem_key, problem_revision, template_vmid,
            status, instance_quota, revision
          ) VALUES ('c-canceled', 1, 'X', 'private-isu', 'v', 9100, 'canceled', 3, 1)
        `
        // 同じ edition=1 の draft は許可される
        const ok = yield* Effect.exit(
          sql`
            INSERT INTO contests (
              id, edition, name, problem_key, problem_revision, template_vmid,
              status, instance_quota, revision
            ) VALUES ('c-draft', 1, 'X', 'private-isu', 'v', 9100, 'draft', 3, 1)
          `
        )
        expect(ok._tag).toBe("Success")

        // 2 つの live 行は拒否される
        const conflict = yield* Effect.exit(
          sql`
            INSERT INTO contests (
              id, edition, name, problem_key, problem_revision, template_vmid,
              status, instance_quota, revision
            ) VALUES ('c-draft-dup', 1, 'X', 'private-isu', 'v', 9100, 'draft', 3, 1)
          `
        )
        expect(conflict._tag).toBe("Failure")
      })
    )
  }
)

it.layer(SqlTest)(
  "migration 0005: 事前 vmid 重複はデータ側で fail-fast する",
  (it) => {
    it.effect("同 vmid の non-deleted 行が既にあるとき MigrationDataError で中断する", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* seedPhase2
        // 通常あり得ないが、legacy DB に vmid=1101 の 2 行(異なる team)を仕込んで
        // 0005 の CREATE UNIQUE INDEX 前チェックが検出できることを確認する。
        yield* sql`INSERT INTO teams (id, name, team_number, created_at) VALUES ('t-x', 'X', 3, 0)`
        yield* sql`
          INSERT INTO instances (id, team_id, idx, vmid, private_ip, status, progress, error_message, created_at, updated_at)
          VALUES ('inst-a', 't-x', 1, 5555, '10.100.3.11', 'running', '["clone_done","configured","started","route_done","access_done"]', NULL, 0, 0)
        `
        yield* sql`INSERT INTO teams (id, name, team_number, created_at) VALUES ('t-y', 'Y', 4, 0)`
        yield* sql`
          INSERT INTO instances (id, team_id, idx, vmid, private_ip, status, progress, error_message, created_at, updated_at)
          VALUES ('inst-b', 't-y', 1, 5555, '10.100.4.11', 'running', '["clone_done","configured","started","route_done","access_done"]', NULL, 0, 0)
        `
        yield* migration0004

        const exit = yield* Effect.exit(sql.withTransaction(migration0005))
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          const err = Cause.failureOption(exit.cause)
          if (Option.isSome(err) && typeof err.value === "object" && err.value !== null && "_tag" in err.value) {
            expect(err.value._tag).toBe("MigrationDataError")
          }
        }
      })
    )
  }
)
