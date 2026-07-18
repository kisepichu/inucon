import { SqlClient } from "@effect/sql"
import { Effect, Layer, Option } from "effect"
import type { TeamId } from "../../../domain/ids.js"
import { TeamInvite } from "../../../domain/teamInvite.js"
import { InviteRepo } from "../../../application/ports.js"
import { decodeRow, wrapSqlError } from "./support.js"

interface InviteRow {
  readonly githubLogin: string
  readonly teamId: string
  readonly email: string
  readonly invitedAt: number
}

const INVITE_COLUMNS = `github_login AS githubLogin, team_id AS teamId, email, invited_at AS invitedAt`

const decodeInvite = (row: InviteRow) => decodeRow(TeamInvite, row)

export const InviteRepoLive: Layer.Layer<InviteRepo, never, SqlClient.SqlClient> = Layer.effect(
  InviteRepo,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const columns = sql.literal(INVITE_COLUMNS)

    return {
      // github_login が PK なので同一 login への再招待は upsert(team/email を
      // 上書き)にする(スペック §Invite)。
      create: (invite: TeamInvite) =>
        wrapSqlError(
          sql`
            INSERT INTO team_invites (github_login, team_id, email, invited_at)
            VALUES (${invite.githubLogin}, ${invite.teamId}, ${invite.email}, ${invite.invitedAt})
            ON CONFLICT (github_login) DO UPDATE SET
              team_id = excluded.team_id,
              email = excluded.email,
              invited_at = excluded.invited_at
          `
        ).pipe(Effect.asVoid),

      findByGithubLogin: (githubLogin: string) =>
        wrapSqlError(
          sql<InviteRow>`SELECT ${columns} FROM team_invites WHERE github_login = ${githubLogin}`
        ).pipe(
          Effect.flatMap((rows) =>
            rows.length === 0
              ? Effect.succeed(Option.none<TeamInvite>())
              : decodeInvite(rows[0]).pipe(Effect.map(Option.some))
          )
        ),

      delete: (githubLogin: string) =>
        wrapSqlError(sql`DELETE FROM team_invites WHERE github_login = ${githubLogin}`).pipe(Effect.asVoid),

      listByTeam: (teamId: TeamId) =>
        wrapSqlError(
          sql<InviteRow>`SELECT ${columns} FROM team_invites WHERE team_id = ${teamId}`
        ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, decodeInvite)))
    }
  })
)
