import { HttpApiBuilder } from "@effect/platform"
import { Effect } from "effect"
import { api, InvalidContestTransition, MemberConflict, NotFound } from "shared"
import { finishContestUsecase, startContestUsecase } from "../../../application/usecases/contest.js"
import { inviteMember, listInvites } from "../../../application/usecases/invites.js"

export const AdminLive = HttpApiBuilder.group(api, "admin", (handlers) =>
  handlers
    .handle("startContest", () =>
      startContestUsecase.pipe(
        Effect.catchTags({
          ContestNotFound: () => Effect.fail(new NotFound()),
          InvalidContestTransition: (e) => Effect.fail(new InvalidContestTransition({ from: e.from, to: e.to }))
        }),
        Effect.orDie
      )
    )
    .handle("finishContest", () =>
      finishContestUsecase.pipe(
        Effect.catchTags({
          ContestNotFound: () => Effect.fail(new NotFound()),
          InvalidContestTransition: (e) => Effect.fail(new InvalidContestTransition({ from: e.from, to: e.to }))
        }),
        Effect.orDie
      )
    )
    .handle("inviteMember", ({ path, payload }) =>
      inviteMember({ teamId: path.id, githubLogin: payload.githubLogin, email: payload.email }).pipe(
        Effect.catchTags({
          TeamNotFound: () => Effect.fail(new NotFound()),
          MemberConflict: (e) => Effect.fail(new MemberConflict({ logins: e.logins }))
        }),
        Effect.orDie
      )
    )
    .handle("listInvites", ({ path }) =>
      listInvites(path.id).pipe(
        Effect.catchTags({ TeamNotFound: () => Effect.fail(new NotFound()) }),
        Effect.orDie
      )
    )
)
