import { Schema } from "effect"
import { ContestId, TeamId } from "./ids.js"

// Task 3: team_invites の 1 行は contest スコープ。(contestId, githubLogin) が
// PK(migration 0005)。同じ login が異なる contest に招待されうる。同一
// contest 内での再招待は upsert(team/email 上書き)。
export class TeamInvite extends Schema.Class<TeamInvite>("TeamInvite")({
  contestId: ContestId,
  githubLogin: Schema.String,
  teamId: TeamId,
  email: Schema.String,
  invitedAt: Schema.Int
}) {}
