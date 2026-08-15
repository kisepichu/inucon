import { SqlClient } from "@effect/sql"
import { Clock, Effect, Layer, Option } from "effect"
import type { ContestId, TeamId, UserId } from "../../../domain/ids.js"
import { Team } from "../../../domain/team.js"
import { User } from "../../../domain/user.js"
import { TeamNumberConflict } from "../../../domain/errors.js"
import { MemberConflict } from "../../../application/errors.js"
import { RepoError, TeamRepo } from "../../../application/ports.js"
import { decodeRow, nullableIntToBool, wrapSqlError } from "./support.js"

interface TeamRow {
  readonly id: string
  readonly contestId: string
  readonly name: string
  readonly teamNumber: number
  readonly desiredInstanceCount: number
}

interface UserRow {
  readonly id: string
  readonly githubId: number
  readonly githubLogin: string
  readonly displayName: string
  readonly isAdmin: number
  readonly email: string | null
}

const TEAM_COLUMNS = `id, contest_id AS contestId, name, team_number AS teamNumber,
  desired_instance_count AS desiredInstanceCount`

export const TeamRepoLive: Layer.Layer<TeamRepo, never, SqlClient.SqlClient> = Layer.effect(
  TeamRepo,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const columns = sql.literal(TEAM_COLUMNS)

    return {
      listByContest: (contestId: ContestId) =>
        wrapSqlError(
          sql<TeamRow>`SELECT ${columns} FROM teams WHERE contest_id = ${contestId} ORDER BY team_number`
        ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeRow(Team, row)))),

      findById: (contestId: ContestId, id: TeamId) =>
        wrapSqlError(
          sql<TeamRow>`SELECT ${columns} FROM teams WHERE id = ${id} AND contest_id = ${contestId}`
        ).pipe(
          Effect.flatMap((rows) =>
            rows.length === 0
              ? Effect.succeed(Option.none<Team>())
              : decodeRow(Team, rows[0]).pipe(Effect.map(Option.some))
          )
        ),

      // scoped unique(contest_id, user_id)を辿って対象 contest 内の所属チーム
      // を返す。異なる contest では同じ user が別チームに所属できる。
      findByUserId: (contestId: ContestId, userId: UserId) =>
        wrapSqlError(
          sql<TeamRow>`
            SELECT teams.id AS id, teams.contest_id AS contestId, teams.name AS name,
                   teams.team_number AS teamNumber,
                   teams.desired_instance_count AS desiredInstanceCount
            FROM team_members
            JOIN teams ON teams.id = team_members.team_id AND teams.contest_id = team_members.contest_id
            WHERE team_members.user_id = ${userId} AND team_members.contest_id = ${contestId}
          `
        ).pipe(
          Effect.flatMap((rows) =>
            rows.length === 0
              ? Effect.succeed(Option.none<Team>())
              : decodeRow(Team, rows[0]).pipe(Effect.map(Option.some))
          )
        ),

      // (contest_id, team_number) の UNIQUE 制約は「INSERT ... SELECT ... WHERE
      // NOT EXISTS ... RETURNING」の単一原子的操作で TOCTOU なく検出する
      // (benchJobRepo.insertIfAllowed と同型)。
      create: (t: Team) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const rows = yield* wrapSqlError(
            sql<{ id: string }>`
              INSERT INTO teams (id, contest_id, name, team_number, desired_instance_count, created_at)
              SELECT ${t.id}, ${t.contestId}, ${t.name}, ${t.teamNumber}, ${t.desiredInstanceCount}, ${now}
              WHERE NOT EXISTS (
                SELECT 1 FROM teams WHERE contest_id = ${t.contestId} AND team_number = ${t.teamNumber}
              )
              RETURNING id
            `
          )
          if (rows.length === 0) {
            return yield* Effect.fail(new TeamNumberConflict({ teamNumber: t.teamNumber }))
          }
        }),

      // Task 2/3 レビュー: usecases 側の pre-check (findByUserId) と
      // setMembers の書き込みは別トランザクションなので、その間に
      // concurrent addMember (consumeLiveInvitesOnLogin 等) が同一 contest
      // 内の別チームに user を入れた場合、INSERT が UNIQUE(contest_id,
      // user_id) で落ちる。素の SqlError → RepoError → 500 は誤解を招く
      // (実態は MemberConflict の 409 相当)ので、UNIQUE 違反を検出したら
      // 診断 SELECT で衝突していた user の github_login を集めて
      // MemberConflict に落とす。DELETE + INSERT + 診断 SELECT を同一
      // sql.withTransaction 内で走らせて INSERT 失敗後の snapshot も
      // 一貫させる(iter 16 レビュー #1)。
      setMembers: (contestId: ContestId, teamId: TeamId, userIds: ReadonlyArray<UserId>) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const writeResult = yield* Effect.gen(function* () {
              yield* sql`
                DELETE FROM team_members
                WHERE contest_id = ${contestId} AND team_id = ${teamId}
              `
              if (userIds.length > 0) {
                yield* sql`
                  INSERT INTO team_members
                  ${sql.insert(userIds.map((userId) => ({
                    contest_id: contestId,
                    team_id: teamId,
                    user_id: userId
                  })))}
                `
              }
              return { ok: true as const }
            }).pipe(
              Effect.catchTag("SqlError", (cause) => Effect.succeed({ ok: false as const, cause }))
            )
            if (writeResult.ok) return

            // INSERT 失敗後、同一 tx 内で診断 SELECT を走らせる。呼び出し元の
            // pre-check が「別チーム所属じゃない」と判定した user のうち、
            // 実際は別チームに存在しているものを github_login 付きで拾う。
            const conflicts = yield* sql<{ githubLogin: string }>`
              SELECT u.github_login AS githubLogin
              FROM team_members tm
              JOIN users u ON u.id = tm.user_id
              WHERE tm.contest_id = ${contestId}
                AND tm.team_id <> ${teamId}
                AND tm.user_id IN ${sql.in(userIds)}
            `.pipe(Effect.catchTag("SqlError", () => Effect.succeed([])))
            if (conflicts.length > 0) {
              return yield* Effect.fail(
                new MemberConflict({ logins: conflicts.map((row) => row.githubLogin) })
              )
            }
            return yield* Effect.fail(new RepoError({ cause: writeResult.cause }))
          })
        ).pipe(Effect.catchTag("SqlError", (cause) => Effect.fail(new RepoError({ cause })))),

      // scoped unique(contest_id, user_id)を TOCTOU なく判定する。同じ user が
      // 別 contest には所属可能。0 行挿入なら false(既に同一 contest 内の
      // どこかのチームへ所属している)。
      addMember: (contestId: ContestId, teamId: TeamId, userId: UserId) =>
        wrapSqlError(
          sql<{ userId: string }>`
            INSERT INTO team_members (contest_id, team_id, user_id)
            SELECT ${contestId}, ${teamId}, ${userId}
            WHERE NOT EXISTS (
              SELECT 1 FROM team_members WHERE contest_id = ${contestId} AND user_id = ${userId}
            )
            RETURNING user_id AS "userId"
          `
        ).pipe(Effect.map((rows) => rows.length > 0)),

      listMembers: (contestId: ContestId, teamId: TeamId) =>
        wrapSqlError(
          sql<UserRow>`
            SELECT users.id AS id, users.github_id AS githubId, users.github_login AS githubLogin,
                   users.display_name AS displayName, users.is_admin AS isAdmin, users.email AS email
            FROM team_members
            JOIN users ON users.id = team_members.user_id
            WHERE team_members.contest_id = ${contestId} AND team_members.team_id = ${teamId}
          `
        ).pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) => decodeRow(User, { ...row, isAdmin: nullableIntToBool(row.isAdmin) }))
          )
        ),

      // Task 5: 単一トランザクションで teams / team_members / team_invites を
      // 一括 INSERT する。呼び出し元は新 team ID の採番と invite → 新 teamId
      // への差し替えを済ませて渡す。
      //
      // Task 5 review finding 2: SQLite は失敗した INSERT の後も同じ tx 内で
      // SELECT を実行できてしまい、直前に成功した INSERT の未 commit 行が
      // 見える。もとの実装は「INSERT 失敗後に diagnostic SELECT で
      // team_number 重複を判定」していたが、team_members / team_invites の
      // INSERT が失敗した場合でも先の teams INSERT の未 commit 行がヒットし、
      // 実際の原因を TeamNumberConflict に誤分類してしまう。原因の
      // SQL エラー文字列に依存せず正しく分類するため、tx を開始した直後に
      // 「target 側の (contest_id, team_number) の重複」だけを先に pre-check
      // し、その後 INSERT を素直に流す。INSERT が SqlError を返したら
      // pre-check が通っている以上 team_number 以外の原因(FK/UNIQUE
      // (contest_id, github_login) 等)なので RepoError へ畳む。
      copyRoster: ({ targetContestId, teams: newTeams, memberships, invites: newInvites }) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            if (newTeams.length > 0) {
              const conflict = yield* sql<{ teamNumber: number }>`
                SELECT team_number AS teamNumber FROM teams
                WHERE contest_id = ${targetContestId}
                  AND team_number IN ${sql.in(newTeams.map((t) => t.teamNumber))}
                LIMIT 1
              `
              if (conflict.length > 0) {
                return yield* Effect.fail(new TeamNumberConflict({ teamNumber: conflict[0].teamNumber }))
              }
              yield* sql`
                INSERT INTO teams
                ${sql.insert(newTeams.map((t) => ({
                  id: t.id,
                  contest_id: t.contestId,
                  name: t.name,
                  team_number: t.teamNumber,
                  desired_instance_count: t.desiredInstanceCount,
                  created_at: now
                })))}
              `
            }
            if (memberships.length > 0) {
              yield* sql`
                INSERT INTO team_members
                ${sql.insert(memberships.map((m) => ({
                  contest_id: targetContestId,
                  team_id: m.teamId,
                  user_id: m.userId
                })))}
              `
            }
            if (newInvites.length > 0) {
              yield* sql`
                INSERT INTO team_invites
                ${sql.insert(newInvites.map((i) => ({
                  contest_id: i.contestId,
                  github_login: i.githubLogin,
                  team_id: i.teamId,
                  email: i.email,
                  invited_at: i.invitedAt
                })))}
              `
            }
          })
        ).pipe(Effect.catchTag("SqlError", (cause) => Effect.fail(new RepoError({ cause }))))
    }
  })
)
