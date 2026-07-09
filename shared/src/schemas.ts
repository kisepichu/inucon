// 境界 Schema(DTO)はここに集約する。後続タスクで追記していく。
//
// ID のブランドは portal/src/domain/ids.ts と同名(構造的ブランドなので相互に
// 代入可能)。portal のドメイン Schema.Class インスタンスはここの Struct 型に
// 構造的に代入できるため、ハンドラは変換なしでそのまま返せる。
import { Schema } from "effect"

export const UserId = Schema.String.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type

export const TeamId = Schema.String.pipe(Schema.brand("TeamId"))
export type TeamId = typeof TeamId.Type

export const User = Schema.Struct({
  id: UserId,
  githubId: Schema.Int,
  githubLogin: Schema.String,
  displayName: Schema.String,
  isAdmin: Schema.Boolean
})
export type User = typeof User.Type

export const Team = Schema.Struct({
  id: TeamId,
  name: Schema.String,
  teamNumber: Schema.Int
})
export type Team = typeof Team.Type

// GET /api/me のレスポンス。チーム未所属は team: null。
export const Me = Schema.Struct({
  user: User,
  team: Schema.NullOr(Team)
})
export type Me = typeof Me.Type
