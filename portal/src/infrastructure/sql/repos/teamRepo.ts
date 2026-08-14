import { SqlClient } from "@effect/sql"
import { Clock, Effect, Layer, Option } from "effect"
import type { ContestId, TeamId, UserId } from "../../../domain/ids.js"
import { Team } from "../../../domain/team.js"
import { User } from "../../../domain/user.js"
import { TeamNumberConflict } from "../../../domain/errors.js"
import { TeamRepo } from "../../../application/ports.js"
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

      setMembers: (contestId: ContestId, teamId: TeamId, userIds: ReadonlyArray<UserId>) =>
        wrapSqlError(
          sql.withTransaction(
            Effect.gen(function* () {
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
            })
          )
        ),

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
        )
    }
  })
)
