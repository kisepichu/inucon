import { Schema } from "effect"
import { UserId } from "./ids.js"

export class User extends Schema.Class<User>("User")({
  id: UserId,
  githubId: Schema.Int,
  githubLogin: Schema.String,
  displayName: Schema.String,
  isAdmin: Schema.Boolean,
  // Cloudflare Access ログイン用メール(Phase 3、スペック §招待フロー)。GitHub
  // OAuth では取得しない(admin が招待時に入力する値)。migration 0002 で
  // users.email が nullable として追加されている(DB 側は Task 2-3 で先行済み。
  // ドメインへの反映は Task 4。既ログインで未招待のユーザーは None)。
  email: Schema.OptionFromNullOr(Schema.String)
}) {}
