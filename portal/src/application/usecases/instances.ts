import { Effect, Either, Option } from "effect"
import { validateBenchTarget } from "../../domain/subnet.js"
import { InstanceId, TeamId } from "../../domain/ids.js"
import { Instance } from "../../domain/instance.js"
import type { User } from "../../domain/user.js"
import { Forbidden, TeamNotFound } from "../errors.js"
import { InstanceRepo, TeamRepo, UuidGen } from "../ports.js"

// GET /api/teams/:id/instances: 当該チームメンバー or admin のみ参照可
// (他チームは Forbidden、403)。対象チームが存在しない場合は TeamNotFound。
export const listTeamInstances = (args: { user: User; teamId: TeamId }) =>
  Effect.gen(function* () {
    const teams = yield* TeamRepo
    yield* teams.findById(args.teamId).pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new TeamNotFound()), onSome: Effect.succeed }))
    )

    if (!args.user.isAdmin) {
      const ownTeam = yield* teams.findByUserId(args.user.id)
      const isMember = Option.isSome(ownTeam) && ownTeam.value.id === args.teamId
      if (!isMember) {
        return yield* Effect.fail(new Forbidden())
      }
    }

    const instances = yield* InstanceRepo
    return yield* instances.listByTeam(args.teamId)
  })

// POST /api/instances: privateIp がチームサブネット外なら domain の
// validateBenchTarget が TargetIpOutOfSubnet を返す(422 にマップ)。同一
// (team, index) の重複は InstanceRepo.create が DuplicateInstanceIndex を
// 返す(409 にマップ)。
export const createInstance = (args: { teamId: TeamId; index: number; privateIp: string }) =>
  Effect.gen(function* () {
    const teams = yield* TeamRepo
    const team = yield* teams.findById(args.teamId).pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new TeamNotFound()), onSome: Effect.succeed }))
    )

    yield* Either.match(validateBenchTarget(args.privateIp, team.teamNumber), {
      onLeft: Effect.fail,
      onRight: Effect.succeed
    })

    const uuidGen = yield* UuidGen
    const id = InstanceId.make(yield* uuidGen.next)
    const instance = new Instance({
      id,
      teamId: args.teamId,
      index: args.index,
      privateIp: args.privateIp,
      status: "active"
    })

    const instances = yield* InstanceRepo
    return yield* instances.create(instance)
  })

// DELETE /api/instances/:id: logout と同様に冪等(存在しない id でも成功)にする。
export const removeInstance = (args: { instanceId: InstanceId }) =>
  InstanceRepo.pipe(Effect.flatMap((repo) => repo.remove(args.instanceId)))
