import { HttpApiBuilder } from "@effect/platform"
import { Effect } from "effect"
import { api, MemberConflict, NotFound, TeamNumberConflict, UnknownGithubLogins } from "shared"
import type { User } from "../../../domain/user.js"
import { createTeam, listTeamsWithMembers, setTeamMembers } from "../../../application/usecases/teams.js"

// TeamRepo.listMembers は domain の User(id/githubId/displayName/isAdmin/...)
// を返すが、契約(shared)の TeamMember は githubLogin 込みの最小フィールドの
// みを公開する(他チームメイトの isAdmin 等まで晒さない)。
const toTeamMember = (u: User) => ({
  id: u.id,
  githubLogin: u.githubLogin,
  displayName: u.displayName
})

export const TeamsLive = HttpApiBuilder.group(api, "teams", (handlers) =>
  handlers
    .handle("listTeams", () =>
      listTeamsWithMembers.pipe(
        Effect.map((rows) => rows.map(({ team, members }) => ({ ...team, members: members.map(toTeamMember) }))),
        Effect.catchTag("ContestNotFound", () => Effect.fail(new NotFound())),
        Effect.orDie
      )
    )
    .handle("createTeam", ({ payload }) =>
      createTeam(payload).pipe(
        Effect.catchTags({
          ContestNotFound: () => Effect.fail(new NotFound()),
          TeamNumberConflict: (e) => Effect.fail(new TeamNumberConflict({ teamNumber: e.teamNumber }))
        }),
        Effect.orDie
      )
    )
    .handle("setTeamMembers", ({ path, payload }) =>
      setTeamMembers({ teamId: path.id, githubLogins: payload.githubLogins }).pipe(
        Effect.map(({ team, members }) => ({ ...team, members: members.map(toTeamMember) })),
        Effect.catchTags({
          ContestNotFound: () => Effect.fail(new NotFound()),
          TeamNotFound: () => Effect.fail(new NotFound()),
          UnknownGithubLogins: (e) => Effect.fail(new UnknownGithubLogins({ logins: e.logins })),
          MemberConflict: (e) => Effect.fail(new MemberConflict({ logins: e.logins }))
        }),
        Effect.orDie
      )
    )
)
