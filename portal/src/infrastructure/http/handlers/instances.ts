import { HttpApiBuilder } from "@effect/platform"
import { Effect } from "effect"
import { api, CurrentUser, DuplicateInstanceIndex, Forbidden, NotFound, TargetIpOutOfSubnet } from "shared"
import { createInstance, listTeamInstances, removeInstance } from "../../../application/usecases/teams.js"

export const InstancesLive = HttpApiBuilder.group(api, "instances", (handlers) =>
  handlers
    .handle("listTeamInstances", ({ path }) =>
      CurrentUser.pipe(
        Effect.flatMap((user) => listTeamInstances({ user, teamId: path.id })),
        Effect.catchTags({
          TeamNotFound: () => Effect.fail(new NotFound()),
          Forbidden: () => Effect.fail(new Forbidden())
        }),
        Effect.orDie
      )
    )
    .handle("createInstance", ({ payload }) =>
      createInstance(payload).pipe(
        Effect.catchTags({
          TeamNotFound: () => Effect.fail(new NotFound()),
          TargetIpOutOfSubnet: (e) => Effect.fail(new TargetIpOutOfSubnet({ ip: e.ip, teamNumber: e.teamNumber })),
          DuplicateInstanceIndex: (e) =>
            Effect.fail(new DuplicateInstanceIndex({ teamId: e.teamId, index: e.index }))
        }),
        Effect.orDie
      )
    )
    .handle("deleteInstance", ({ path }) => removeInstance({ instanceId: path.id }).pipe(Effect.orDie))
)
