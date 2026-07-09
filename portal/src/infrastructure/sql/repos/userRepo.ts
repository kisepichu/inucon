import { SqlClient } from "@effect/sql"
import { Clock, Effect, Layer, Option } from "effect"
import type { UserId } from "../../../domain/ids.js"
import { User } from "../../../domain/user.js"
import { UserRepo, UuidGen } from "../../../application/ports.js"
import { boolToInt, decodeRow, nullableIntToBool, wrapSqlError } from "./support.js"

interface UserRow {
  readonly id: string
  readonly githubId: number
  readonly githubLogin: string
  readonly displayName: string
  readonly isAdmin: number
}

const decodeUser = (row: UserRow) => decodeRow(User, { ...row, isAdmin: nullableIntToBool(row.isAdmin) })

export const UserRepoLive: Layer.Layer<UserRepo, never, SqlClient.SqlClient | UuidGen> = Layer.effect(
  UserRepo,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const uuidGen = yield* UuidGen

    return {
      // github_id が UNIQUE のため INSERT ... ON CONFLICT で upsert する。
      // 既存行がある場合、id は変えず内容(login/displayName/isAdmin)だけ
      // 更新する。
      upsertByGithub: (u) =>
        Effect.gen(function* () {
          const id = yield* uuidGen.next
          const now = yield* Clock.currentTimeMillis
          const rows = yield* wrapSqlError(
            sql<UserRow>`
              INSERT INTO users (id, github_id, github_login, display_name, is_admin, created_at)
              VALUES (${id}, ${u.githubId}, ${u.githubLogin}, ${u.displayName}, ${boolToInt(u.isAdmin)}, ${now})
              ON CONFLICT (github_id) DO UPDATE SET
                github_login = excluded.github_login,
                display_name = excluded.display_name,
                is_admin = excluded.is_admin
              RETURNING id, github_id AS githubId, github_login AS githubLogin,
                        display_name AS displayName, is_admin AS isAdmin
            `
          )
          return yield* decodeUser(rows[0])
        }),

      findById: (id: UserId) =>
        wrapSqlError(
          sql<UserRow>`
            SELECT id, github_id AS githubId, github_login AS githubLogin,
                   display_name AS displayName, is_admin AS isAdmin
            FROM users WHERE id = ${id}
          `
        ).pipe(
          Effect.flatMap((rows) =>
            rows.length === 0 ? Effect.succeed(Option.none<User>()) : decodeUser(rows[0]).pipe(Effect.map(Option.some))
          )
        )
    }
  })
)
