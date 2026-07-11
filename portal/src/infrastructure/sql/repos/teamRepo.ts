import { SqlClient } from "@effect/sql"
import { Clock, Effect, Layer, Option } from "effect"
import type { TeamId, UserId } from "../../../domain/ids.js"
import { Team } from "../../../domain/team.js"
import { User } from "../../../domain/user.js"
import { TeamNumberConflict } from "../../../domain/errors.js"
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
  readonly email: string | null
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

      // team_number の UNIQUE 制約は「INSERT ... SELECT ... WHERE NOT EXISTS
      // ... RETURNING」の単一原子的操作で検出する(benchJobRepo.insertIfAllowed
      // と同じ形。SQL エラーメッセージの文字列判定より TOCTOU 安全)。
      create: (t: Team) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const rows = yield* wrapSqlError(
            sql<{ id: string }>`
              INSERT INTO teams (id, name, team_number, created_at)
              SELECT ${t.id}, ${t.name}, ${t.teamNumber}, ${now}
              WHERE NOT EXISTS (SELECT 1 FROM teams WHERE team_number = ${t.teamNumber})
              RETURNING id
            `
          )
          if (rows.length === 0) {
            return yield* Effect.fail(new TeamNumberConflict({ teamNumber: t.teamNumber }))
          }
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

      // 単一メンバーの追加(Phase 3 招待フロー)。team_members.user_id は
      // UNIQUE。TOCTOU 回避のため「INSERT ... SELECT ... WHERE NOT EXISTS
      // ... RETURNING」の単一原子的操作で判定する(TeamRepo.create /
      // benchJobRepo.insertIfAllowed と同型)。0 行挿入(= 既に何らかのチーム
      // に所属済み)なら false を返す。他チームからの横取り防止・冪等判定
      // (要求チームと同じか異なるか)は呼び出し元
      // (application/usecases/invites.ts・auth.ts)が false を見て行う責務。
      addMember: (teamId: TeamId, userId: UserId) =>
        wrapSqlError(
          sql<{ userId: string }>`
            INSERT INTO team_members (team_id, user_id)
            SELECT ${teamId}, ${userId}
            WHERE NOT EXISTS (SELECT 1 FROM team_members WHERE user_id = ${userId})
            RETURNING user_id AS "userId"
          `
        ).pipe(Effect.map((rows) => rows.length > 0)),

      listMembers: (teamId: TeamId) =>
        wrapSqlError(
          sql<UserRow>`
            SELECT users.id AS id, users.github_id AS githubId, users.github_login AS githubLogin,
                   users.display_name AS displayName, users.is_admin AS isAdmin, users.email AS email
            FROM team_members
            JOIN users ON users.id = team_members.user_id
            WHERE team_members.team_id = ${teamId}
          `
        ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, decodeUser)))
    }
  })
)
