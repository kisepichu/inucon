import { Schema } from "effect"
import { UserId } from "./ids.js"

export class User extends Schema.Class<User>("User")({
  id: UserId,
  githubId: Schema.Number,
  githubLogin: Schema.String,
  displayName: Schema.String,
  isAdmin: Schema.Boolean
}) {}
