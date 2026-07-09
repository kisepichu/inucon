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

export const ContestId = Schema.String.pipe(Schema.brand("ContestId"))
export type ContestId = typeof ContestId.Type

export const InstanceId = Schema.String.pipe(Schema.brand("InstanceId"))
export type InstanceId = typeof InstanceId.Type

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
  teamNumber: Schema.Int.pipe(Schema.between(1, 254))
})
export type Team = typeof Team.Type

// GET /api/me のレスポンス。チーム未所属は team: null。
export const Me = Schema.Struct({
  user: User,
  team: Schema.NullOr(Team)
})
export type Me = typeof Me.Type

export const ContestStatus = Schema.Literal("preparing", "running", "finished")
export type ContestStatus = typeof ContestStatus.Type

export const Contest = Schema.Struct({
  id: ContestId,
  name: Schema.String,
  problemKey: Schema.String,
  status: ContestStatus
})
export type Contest = typeof Contest.Type

// GET /api/teams のメンバー表現。チームメイトの githubLogin を返す(auth の
// User 全体を返すと isAdmin 等の不要な情報まで漏れるため最小限にする)。
export const TeamMember = Schema.Struct({
  id: UserId,
  githubLogin: Schema.String,
  displayName: Schema.String
})
export type TeamMember = typeof TeamMember.Type

export const TeamWithMembers = Schema.Struct({
  ...Team.fields,
  members: Schema.Array(TeamMember)
})
export type TeamWithMembers = typeof TeamWithMembers.Type

export const Instance = Schema.Struct({
  id: InstanceId,
  teamId: TeamId,
  index: Schema.Int.pipe(Schema.positive()),
  privateIp: Schema.String,
  status: Schema.Literal("active")
})
export type Instance = typeof Instance.Type

// POST /api/teams
export const CreateTeamRequest = Schema.Struct({
  name: Schema.String,
  teamNumber: Schema.Int.pipe(Schema.between(1, 254))
})
export type CreateTeamRequest = typeof CreateTeamRequest.Type

// PUT /api/teams/:id/members
export const SetTeamMembersRequest = Schema.Struct({
  githubLogins: Schema.Array(Schema.String)
})
export type SetTeamMembersRequest = typeof SetTeamMembersRequest.Type

// POST /api/instances
export const CreateInstanceRequest = Schema.Struct({
  teamId: TeamId,
  index: Schema.Int.pipe(Schema.positive()),
  privateIp: Schema.String
})
export type CreateInstanceRequest = typeof CreateInstanceRequest.Type
