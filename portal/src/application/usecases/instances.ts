import { Clock, Effect, Either, Option } from "effect"
import { validateBenchTarget } from "../../domain/subnet.js"
import { InstanceId, TeamId } from "../../domain/ids.js"
import { Instance, vmidFor } from "../../domain/instance.js"
import type { ProvisionStep } from "../../domain/instance.js"
import type { User } from "../../domain/user.js"
import { Forbidden, TeamNotFound } from "../errors.js"
import { InstanceRepo, TeamRepo, UuidGen } from "../ports.js"

// スペック §HTTP API(差分): この admin 専用経路は「Terraform 製 VM の台帳
// 取り込み」用に残す(Phase 2 からの引き継ぎ)。対象 VM は登録時点で既に
// 起動済みという前提のため、状態機械上は creating を経由せず直ちに running
// として登録する(全 provision step 済み扱い)。
const ALL_PROVISION_STEPS: ReadonlyArray<ProvisionStep> = [
  "clone_done",
  "configured",
  "started",
  "route_done",
  "access_done"
]

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
// 返す(409 にマップ)。vmid が指定されればそれをそのまま台帳に記録し
// (Terraform 製 VM の実績 vmid を取り込む用途)、省略時は従来どおり
// vmidFor(teamNumber, index) で計算する(後方互換)。
export const createInstance = (args: {
  teamId: TeamId
  index: number
  privateIp: string
  vmid?: number | undefined
}) =>
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
    const now = yield* Clock.currentTimeMillis
    const instance = new Instance({
      id,
      teamId: args.teamId,
      index: args.index,
      vmid: args.vmid ?? vmidFor(team.teamNumber, args.index),
      privateIp: args.privateIp,
      status: "running",
      progress: ALL_PROVISION_STEPS,
      errorMessage: Option.none(),
      createdAt: now,
      updatedAt: now
    })

    const instances = yield* InstanceRepo
    return yield* instances.create(instance)
  })

// DELETE /api/instances/:id: logout と同様に冪等(存在しない id でも成功)にする。
export const removeInstance = (args: { instanceId: InstanceId }) =>
  InstanceRepo.pipe(Effect.flatMap((repo) => repo.remove(args.instanceId)))
