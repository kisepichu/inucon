import { Schema } from "effect"
import { TeamId } from "./ids.js"

// team_invites の 1 行(スペック §Invite): 未ログインユーザーへの事前割当。
// githubLogin が PK(migration 0002)。本人が初ログインしたとき自動で
// teamId のチームに所属し、この行は消費(削除)される。
export class TeamInvite extends Schema.Class<TeamInvite>("TeamInvite")({
  githubLogin: Schema.String,
  teamId: TeamId,
  email: Schema.String,
  invitedAt: Schema.Int
}) {}
