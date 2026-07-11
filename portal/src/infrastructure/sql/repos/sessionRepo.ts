import { randomBytes } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { Clock, Effect, Layer, Option } from "effect"
import type { UserId } from "../../../domain/ids.js"
import { User } from "../../../domain/user.js"
import { SessionRepo } from "../../../application/ports.js"
import { decodeRow, nullableIntToBool, wrapSqlError } from "./support.js"

interface UserRow {
  readonly id: string
  readonly githubId: number
  readonly githubLogin: string
  readonly displayName: string
  readonly isAdmin: number
  readonly email: string | null
}

const decodeUser = (row: UserRow) => decodeRow(User, { ...row, isAdmin: nullableIntToBool(row.isAdmin) })

export const SessionRepoLive: Layer.Layer<SessionRepo, never, SqlClient.SqlClient> = Layer.effect(
  SessionRepo,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return {
      create: (userId: UserId, expiresAt: number) =>
        Effect.gen(function* () {
          const id = randomBytes(32).toString("hex")
          const now = yield* Clock.currentTimeMillis
          yield* wrapSqlError(
            sql`INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (${id}, ${userId}, ${expiresAt}, ${now})`
          )
          return id
        }),

      findValidUser: (sessionId: string, now: number) =>
        wrapSqlError(
          sql<UserRow>`
            SELECT users.id AS id, users.github_id AS githubId, users.github_login AS githubLogin,
                   users.display_name AS displayName, users.is_admin AS isAdmin, users.email AS email
            FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.id = ${sessionId} AND sessions.expires_at > ${now}
          `
        ).pipe(
          Effect.flatMap((rows) =>
            rows.length === 0 ? Effect.succeed(Option.none<User>()) : decodeUser(rows[0]).pipe(Effect.map(Option.some))
          )
        ),

      delete: (sessionId: string) => wrapSqlError(sql`DELETE FROM sessions WHERE id = ${sessionId}`).pipe(Effect.asVoid)
    }
  })
)
