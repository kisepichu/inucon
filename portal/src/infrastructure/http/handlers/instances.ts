import { HttpApiBuilder } from "@effect/platform"
import { Effect, Option } from "effect"
import { api, CurrentUser, DuplicateInstanceIndex, Forbidden, NotFound, TargetIpOutOfSubnet } from "shared"
import type { Instance } from "../../../domain/instance.js"
import { createInstance, listTeamInstances, removeInstance } from "../../../application/usecases/instances.js"

// domain の Instance(errorMessage が Option)を契約(shared)の Instance
// (null 許容)に変換する。bench.ts の toBenchJobResponse と同じ方針。
const toInstanceResponse = (i: Instance) => ({
  id: i.id,
  teamId: i.teamId,
  index: i.index,
  vmid: i.vmid,
  privateIp: i.privateIp,
  status: i.status,
  progress: i.progress,
  errorMessage: Option.getOrNull(i.errorMessage),
  createdAt: i.createdAt,
  updatedAt: i.updatedAt
})

export const InstancesLive = HttpApiBuilder.group(api, "instances", (handlers) =>
  handlers
    .handle("listTeamInstances", ({ path }) =>
      CurrentUser.pipe(
        Effect.flatMap((user) => listTeamInstances({ user, teamId: path.id })),
        Effect.map((instances) => instances.map(toInstanceResponse)),
        Effect.catchTags({
          TeamNotFound: () => Effect.fail(new NotFound()),
          Forbidden: () => Effect.fail(new Forbidden())
        }),
        Effect.orDie
      )
    )
    .handle("createInstance", ({ payload }) =>
      createInstance(payload).pipe(
        Effect.map(toInstanceResponse),
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
