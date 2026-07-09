import { SqlClient } from "@effect/sql"
import { Clock, Effect, Layer, Option } from "effect"
import type { TeamId, UserId } from "../../../domain/ids.js"
import { Team } from "../../../domain/team.js"
import { User } from "../../../domain/user.js"
import { TeamRepo } from "../../../application/ports.js"
import { decodeRow, nullableIntToBool, wrapSqlError } from "./support.js"

interface TeamRow {
  readonly id: string
  readonly name: string
  readonly teamNumber: number
}

interface UserRow {
  readonly id: string
  readonly githubId: number
  readonly githubLogin: string
  readonly displayName: string
  readonly isAdmin: number
}

const decodeTeam = (row: TeamRow) => decodeRow(Team, row)
const decodeUser = (row: UserRow) => decodeRow(User, { ...row, isAdmin: nullableIntToBool(row.isAdmin) })

export const TeamRepoLive: Layer.Layer<TeamRepo, never, SqlClient.SqlClient> = Layer.effect(
  TeamRepo,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return {
      list: wrapSqlError(
        sql<TeamRow>`SELECT id, name, team_number AS teamNumber FROM teams ORDER BY team_number`
      ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, decodeTeam))),

      findById: (id: TeamId) =>
        wrapSqlError(
          sql<TeamRow>`SELECT id, name, team_number AS teamNumber FROM teams WHERE id = ${id}`
        ).pipe(
          Effect.flatMap((rows) =>
            rows.length === 0 ? Effect.succeed(Option.none<Team>()) : decodeTeam(rows[0]).pipe(Effect.map(Option.some))
          )
        ),

      findByUserId: (userId: UserId) =>
        wrapSqlError(
          sql<TeamRow>`
            SELECT teams.id AS id, teams.name AS name, teams.team_number AS teamNumber
            FROM team_members
            JOIN teams ON teams.id = team_members.team_id
            WHERE team_members.user_id = ${userId}
          `
        ).pipe(
          Effect.flatMap((rows) =>
            rows.length === 0 ? Effect.succeed(Option.none<Team>()) : decodeTeam(rows[0]).pipe(Effect.map(Option.some))
          )
        ),

      create: (t: Team) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          yield* wrapSqlError(
            sql`INSERT INTO teams (id, name, team_number, created_at) VALUES (${t.id}, ${t.name}, ${t.teamNumber}, ${now})`
          )
        }),

      // 既存メンバーを全消しして渡された userIds で置き換える(全量置換)。
      setMembers: (teamId: TeamId, userIds: ReadonlyArray<UserId>) =>
        wrapSqlError(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM team_members WHERE team_id = ${teamId}`
              if (userIds.length > 0) {
                yield* sql`
                  INSERT INTO team_members
                  ${sql.insert(userIds.map((userId) => ({ team_id: teamId, user_id: userId })))}
                `
              }
            })
          )
        ),

      listMembers: (teamId: TeamId) =>
        wrapSqlError(
          sql<UserRow>`
            SELECT users.id AS id, users.github_id AS githubId, users.github_login AS githubLogin,
                   users.display_name AS displayName, users.is_admin AS isAdmin
            FROM team_members
            JOIN users ON users.id = team_members.user_id
            WHERE team_members.team_id = ${teamId}
          `
        ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, decodeUser)))
    }
  })
)
