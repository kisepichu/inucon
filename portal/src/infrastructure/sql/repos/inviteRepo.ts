import { SqlClient } from "@effect/sql"
import { Effect, Layer, Option } from "effect"
import type { ContestId, TeamId } from "../../../domain/ids.js"
import { TeamInvite } from "../../../domain/teamInvite.js"
import { InviteRepo } from "../../../application/ports.js"
import { decodeRow, wrapSqlError } from "./support.js"

interface InviteRow {
  readonly contestId: string
  readonly githubLogin: string
  readonly teamId: string
  readonly email: string
  readonly invitedAt: number
}

const INVITE_COLUMNS = `contest_id AS contestId, github_login AS githubLogin,
  team_id AS teamId, email, invited_at AS invitedAt`

export const InviteRepoLive: Layer.Layer<InviteRepo, never, SqlClient.SqlClient> = Layer.effect(
  InviteRepo,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const columns = sql.literal(INVITE_COLUMNS)

    return {
      // (contest_id, github_login) が PK。同一 contest の再招待は upsert
      // (team/email 上書き)。異なる contest への招待は別行として共存する。
      create: (invite: TeamInvite) =>
        wrapSqlError(
          sql`
            INSERT INTO team_invites (contest_id, github_login, team_id, email, invited_at)
            VALUES (${invite.contestId}, ${invite.githubLogin}, ${invite.teamId}, ${invite.email}, ${invite.invitedAt})
            ON CONFLICT (contest_id, github_login) DO UPDATE SET
              team_id = excluded.team_id,
              email = excluded.email,
              invited_at = excluded.invited_at
          `
        ).pipe(Effect.asVoid),

      findByGithubLogin: (contestId: ContestId, githubLogin: string) =>
        wrapSqlError(
          sql<InviteRow>`
            SELECT ${columns} FROM team_invites
            WHERE contest_id = ${contestId} AND github_login = ${githubLogin}
          `
        ).pipe(
          Effect.flatMap((rows) =>
            rows.length === 0
              ? Effect.succeed(Option.none<TeamInvite>())
              : decodeRow(TeamInvite, rows[0]).pipe(Effect.map(Option.some))
          )
        ),

      delete: (contestId: ContestId, githubLogin: string) =>
        wrapSqlError(
          sql`DELETE FROM team_invites WHERE contest_id = ${contestId} AND github_login = ${githubLogin}`
        ).pipe(Effect.asVoid),

      listByTeam: (contestId: ContestId, teamId: TeamId) =>
        wrapSqlError(
          sql<InviteRow>`
            SELECT ${columns} FROM team_invites
            WHERE contest_id = ${contestId} AND team_id = ${teamId}
          `
        ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeRow(TeamInvite, row)))),

      // Task 3 Step 5: 初ログイン時に消費する候補は draft/preparing/running/
      // finalizing の 4 状態(finalizing 中の初ログインでも roster に載せて
      // archive に反映するため include。finished/canceled は read-only なので
      // 招待残骸があっても無視する)。
      listByGithubLoginForLiveContests: (githubLogin: string) =>
        wrapSqlError(
          sql<InviteRow>`
            SELECT ${columns} FROM team_invites
            JOIN contests ON contests.id = team_invites.contest_id
            WHERE team_invites.github_login = ${githubLogin}
              AND contests.status IN ('draft','preparing','running','finalizing')
          `
        ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeRow(TeamInvite, row))))
    }
  })
)
