import { Clock, Effect, Either, Option } from "effect"
import { validateBenchTarget } from "../../domain/subnet.js"
import { InvalidInstanceTransition } from "../../domain/errors.js"
import { ContestId, InstanceId, TeamId } from "../../domain/ids.js"
import { Instance, newInstance, vmidFor } from "../../domain/instance.js"
import type { ProvisionStep } from "../../domain/instance.js"
import type { User } from "../../domain/user.js"
import {
  ContestNotFound,
  Forbidden,
  InsufficientMemory,
  InstanceInUse,
  ProvisionInProgress,
  QuotaExceeded,
  TeamNotFound
} from "../errors.js"
import { BenchJobRepo, ContestRepo, InstanceRepo, ProvisioningConfig, ProxmoxPort, TeamRepo, UuidGen } from "../ports.js"

// admin 台帳取り込みは対象 VM が既に起動済み前提のため、状態機械上 creating を
// 経由せず running で登録する(全 provision step 済み扱い)。
const ALL_PROVISION_STEPS: ReadonlyArray<ProvisionStep> = [
  "clone_done",
  "configured",
  "started",
  "route_done",
  "access_done"
]

// Task 3: 互換 handler は「今 operational な contest」を解決してから scoped
// repo を呼ぶ(bench 系と同じ方針)。0 contest 状態は ContestNotFound(404)。
const resolveOperationalContestId = ContestRepo.pipe(
  Effect.flatMap((repo) => repo.getOperational),
  Effect.flatMap(Option.match({ onNone: () => Effect.fail(new ContestNotFound()), onSome: Effect.succeed })),
  Effect.map((c) => c.id)
)

// listTeamInstances 用: mutation ではなく履歴表示なので getDisplay を使う。
// running/finalizing > 最新 finished > preparing の順で「今見せるべき
// contest」を返し、finished でも過去のインスタンスを表示できるようにする。
// 0 contest 時は ContestNotFound(404)で従来通り。
const resolveDisplayContestId = ContestRepo.pipe(
  Effect.flatMap((repo) => repo.getDisplay),
  Effect.flatMap(Option.match({ onNone: () => Effect.fail(new ContestNotFound()), onSome: Effect.succeed })),
  Effect.map((c) => c.id)
)

// listTeamInstances / requestCreateInstance / requestDeleteInstance 共通の
// 認可チェック(当該チームメンバー or admin)。
const assertTeamMemberOrAdmin = (contestId: ContestId, user: User, teamId: TeamId) =>
  Effect.gen(function* () {
    if (user.isAdmin) return
    const teams = yield* TeamRepo
    const ownTeam = yield* teams.findByUserId(contestId, user.id)
    const isMember = Option.isSome(ownTeam) && ownTeam.value.id === teamId
    if (!isMember) {
      return yield* Effect.fail(new Forbidden())
    }
  })

export const listTeamInstances = (args: { user: User; teamId: TeamId }) =>
  Effect.gen(function* () {
    const contestId = yield* resolveDisplayContestId
    const teams = yield* TeamRepo
    yield* teams.findById(contestId, args.teamId).pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new TeamNotFound()), onSome: Effect.succeed }))
    )

    yield* assertTeamMemberOrAdmin(contestId, args.user, args.teamId)

    const instances = yield* InstanceRepo
    return yield* instances.listByTeam(contestId, args.teamId)
  })

// POST /api/instances(admin 台帳取り込み)。互換 handler は operational contest
// を解決してからその contest に登録する。
export const createInstance = (args: {
  teamId: TeamId
  index: number
  privateIp: string
  vmid?: number | undefined
}) =>
  Effect.gen(function* () {
    const contestId = yield* resolveOperationalContestId
    const teams = yield* TeamRepo
    const team = yield* teams.findById(contestId, args.teamId).pipe(
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
      contestId,
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

// DELETE /api/instances/:id: admin 台帳操作(logout と同様に冪等)。
export const removeInstance = (args: { instanceId: InstanceId }) =>
  InstanceRepo.pipe(Effect.flatMap((repo) => repo.remove(args.instanceId)))

// POST /api/teams/:id/instances: セルフサービス追加ボタン。
export const requestCreateInstance = (args: { user: User; teamId: TeamId }) =>
  Effect.gen(function* () {
    const contests = yield* ContestRepo
    const contest = yield* contests.getOperational.pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new ContestNotFound()), onSome: Effect.succeed }))
    )
    const contestId = contest.id

    const teams = yield* TeamRepo
    const team = yield* teams.findById(contestId, args.teamId).pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new TeamNotFound()), onSome: Effect.succeed }))
    )

    yield* assertTeamMemberOrAdmin(contestId, args.user, args.teamId)

    const instances = yield* InstanceRepo
    const existing = yield* instances.listByTeam(contestId, team.id)
    const activeCount = existing.filter((x) => x.status === "creating" || x.status === "running").length
    if (activeCount >= contest.instanceQuota) {
      return yield* Effect.fail(new QuotaExceeded({ teamId: team.id, quota: contest.instanceQuota }))
    }
    const inProgress = existing.some((x) => x.status === "creating" || x.status === "deleting")
    if (inProgress) {
      return yield* Effect.fail(new ProvisionInProgress({ teamId: team.id }))
    }

    const occupiedIndices = new Set(existing.filter((x) => x.status !== "deleted").map((x) => x.index))
    const MAX_INSTANCE_INDEX = 99
    let index: number | undefined
    for (let i = 1; i <= MAX_INSTANCE_INDEX; i++) {
      if (!occupiedIndices.has(i)) {
        index = i
        break
      }
    }
    if (index === undefined) {
      return yield* Effect.fail(new QuotaExceeded({ teamId: team.id, quota: contest.instanceQuota }))
    }

    const config = yield* ProvisioningConfig
    const proxmox = yield* ProxmoxPort
    const freeBytes = yield* proxmox.getNodeFreeMemBytes
    if (freeBytes < config.minFreeMemBytes) {
      return yield* Effect.fail(new InsufficientMemory({ freeBytes, requiredBytes: config.minFreeMemBytes }))
    }

    const uuidGen = yield* UuidGen
    const id = InstanceId.make(yield* uuidGen.next)
    const now = yield* Clock.currentTimeMillis
    const instance = newInstance({
      id,
      contestId,
      teamId: team.id,
      index,
      teamNumber: team.teamNumber,
      now
    })

    return yield* instances.createIfAllowed(instance, contest.instanceQuota, { owningOperationId: Option.none() })
  })

// DELETE /api/teams/:id/instances/:instanceId(セルフサービス削除)。
// 対象 Instance 自身が contestId を持つため、追加の resolve は不要。
export const requestDeleteInstance = (args: { user: User; instanceId: InstanceId }) =>
  Effect.gen(function* () {
    const instances = yield* InstanceRepo
    const instance = yield* instances.findById(args.instanceId).pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new Forbidden()), onSome: Effect.succeed }))
    )

    yield* assertTeamMemberOrAdmin(instance.contestId, args.user, instance.teamId)

    if (instance.status !== "running" && instance.status !== "failed") {
      return yield* Effect.fail(
        new InvalidInstanceTransition({ instanceId: instance.id, from: instance.status, to: "deleting" })
      )
    }

    const jobs = yield* BenchJobRepo
    const teamJobs = yield* jobs.listByTeam(instance.contestId, instance.teamId, 50)
    const inUse = teamJobs.some(
      (j) => j.targetIp === instance.privateIp && (j.status === "queued" || j.status === "running")
    )
    if (inUse) {
      return yield* Effect.fail(new InstanceInUse({ instanceId: instance.id }))
    }

    const now = yield* Clock.currentTimeMillis
    const updated = yield* instances.beginDeletingIfAllowed(instance.id, now, { owningOperationId: Option.none() })
    if (Option.isSome(updated)) {
      return updated.value
    }

    const recheck = yield* instances.findById(instance.id)
    if (Option.isNone(recheck)) {
      return yield* Effect.fail(new Forbidden())
    }
    if (recheck.value.status !== "running" && recheck.value.status !== "failed") {
      return yield* Effect.fail(
        new InvalidInstanceTransition({ instanceId: recheck.value.id, from: recheck.value.status, to: "deleting" })
      )
    }

    const recheckJobs = yield* jobs.listByTeam(recheck.value.contestId, recheck.value.teamId, 50)
    const stillInUse = recheckJobs.some(
      (j) => j.targetIp === recheck.value.privateIp && (j.status === "queued" || j.status === "running")
    )
    if (stillInUse) {
      return yield* Effect.fail(new InstanceInUse({ instanceId: recheck.value.id }))
    }

    return yield* Effect.fail(new ProvisionInProgress({ teamId: instance.teamId }))
  })
