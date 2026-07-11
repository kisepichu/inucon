import { Clock, Effect, Either, Option } from "effect"
import { validateBenchTarget } from "../../domain/subnet.js"
import { InvalidInstanceTransition } from "../../domain/errors.js"
import { InstanceId, TeamId } from "../../domain/ids.js"
import { beginDeleting, Instance, newInstance, vmidFor } from "../../domain/instance.js"
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

// listTeamInstances / requestCreateInstance / requestDeleteInstance 共通の
// 認可チェック(当該チームメンバー or admin)。
const assertTeamMemberOrAdmin = (user: User, teamId: TeamId) =>
  Effect.gen(function* () {
    if (user.isAdmin) return
    const teams = yield* TeamRepo
    const ownTeam = yield* teams.findByUserId(user.id)
    const isMember = Option.isSome(ownTeam) && ownTeam.value.id === teamId
    if (!isMember) {
      return yield* Effect.fail(new Forbidden())
    }
  })

// GET /api/teams/:id/instances: 当該チームメンバー or admin のみ参照可
// (他チームは Forbidden、403)。対象チームが存在しない場合は TeamNotFound。
export const listTeamInstances = (args: { user: User; teamId: TeamId }) =>
  Effect.gen(function* () {
    const teams = yield* TeamRepo
    yield* teams.findById(args.teamId).pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new TeamNotFound()), onSome: Effect.succeed }))
    )

    yield* assertTeamMemberOrAdmin(args.user, args.teamId)

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
// Phase 2 からの引き継ぎ(admin 台帳操作用)。Phase 3 のユーザー向け削除は
// requestDeleteInstance(状態ガード + saga の deleting 遷移)を使う。
export const removeInstance = (args: { instanceId: InstanceId }) =>
  InstanceRepo.pipe(Effect.flatMap((repo) => repo.remove(args.instanceId)))

// POST /api/teams/:id/instances(追加ボタン、スペック §HTTP API): トランザク
// ション内で quota 再検証 + 進行中(creating/deleting)1 本チェック + INSERT を
// 単一の原子的操作(InstanceRepo.createIfAllowed)で行う。RAM ガード
// (ProxmoxPort.getNodeFreeMemBytes)は別システムへの呼び出しのため DB
// トランザクションの外側で先に検証する(作成前に free ≥ 閾値を要求する、
// spike メモ §リスク4)。ガード通過後は creating 行を返す(202 相当、実処理は
// ワーカー/saga が引き継ぐ)。
//
// ガード順序(Task 4 レビュー M5): quota/進行中は DB 読み取りだけの安価な
// 判定である一方、RAM ガードは Proxmox への実 HTTP 呼び出しを伴う。
// createIfAllowed が最終的にトランザクション内で quota/進行中を原子的に
// 再検証するため二重判定にはなるが、「軽い方を先に」失敗させることで、
// どうせ弾かれる quota 超過/進行中のリクエストで無駄な Proxmox 呼び出しを
// 起こさない(fail-fast)。ここでの事前チェックは非原子的(TOCTOU あり)だが、
// 正しさの最終保証は原子的な createIfAllowed 側にあるため実害は無い。
export const requestCreateInstance = (args: { user: User; teamId: TeamId; index: number }) =>
  Effect.gen(function* () {
    const teams = yield* TeamRepo
    const team = yield* teams.findById(args.teamId).pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new TeamNotFound()), onSome: Effect.succeed }))
    )

    yield* assertTeamMemberOrAdmin(args.user, args.teamId)

    const contests = yield* ContestRepo
    const contest = yield* contests.getCurrent.pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new ContestNotFound()), onSome: Effect.succeed }))
    )

    const instances = yield* InstanceRepo
    const existing = yield* instances.listByTeam(team.id)
    const activeCount = existing.filter((x) => x.status === "creating" || x.status === "running").length
    if (activeCount >= contest.instanceQuota) {
      return yield* Effect.fail(new QuotaExceeded({ teamId: team.id, quota: contest.instanceQuota }))
    }
    const inProgress = existing.some((x) => x.status === "creating" || x.status === "deleting")
    if (inProgress) {
      return yield* Effect.fail(new ProvisionInProgress({ teamId: team.id }))
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
      teamId: team.id,
      index: args.index,
      teamNumber: team.teamNumber,
      now
    })

    return yield* instances.createIfAllowed(instance, contest.instanceQuota)
  })

// DELETE /api/instances/:id(削除ボタン、スペック §HTTP API): running または
// failed を受理する(creating/deleting/deleted からの削除要求は
// InvalidInstanceTransition = 409)。failed 許容は Task 4 レビュー I4:
// domain の beginDeleting は running/failed 両方から deleting への遷移を
// 許すが、旧実装はこの経路で running しか受け付けておらず、C1 の孤児 VM や
// 途中失敗で failed になったインスタンスをユーザー自身が掃除できなかった。
// 認可(当該チーム or admin)は従来どおり。削除対象の privateIp を targetIp
// とする BenchJob が queued/running なら InstanceInUse(409、ベンチ対象の
// 消失防止) — failed インスタンスは running ではないため通常このチェックに
// 引っかかることは無いが、ガード自体は running/failed で分岐させず維持する
// (対象 IP が偶然一致するケースを含め、単純さを優先)。ガード通過後は
// beginDeleting で deleting へ遷移させ、実処理(撤収 saga)はワーカーが
// 引き継ぐ。存在しない instanceId は「他チームのインスタンス」と同じ
// Forbidden として扱う(cancelBench と同様、ID の存在有無を漏らさない)。
export const requestDeleteInstance = (args: { user: User; instanceId: InstanceId }) =>
  Effect.gen(function* () {
    const instances = yield* InstanceRepo
    const instance = yield* instances.findById(args.instanceId).pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new Forbidden()), onSome: Effect.succeed }))
    )

    yield* assertTeamMemberOrAdmin(args.user, instance.teamId)

    if (instance.status !== "running" && instance.status !== "failed") {
      return yield* Effect.fail(
        new InvalidInstanceTransition({ instanceId: instance.id, from: instance.status, to: "deleting" })
      )
    }

    const jobs = yield* BenchJobRepo
    const teamJobs = yield* jobs.listByTeam(instance.teamId, 50)
    const inUse = teamJobs.some(
      (j) => j.targetIp === instance.privateIp && (j.status === "queued" || j.status === "running")
    )
    if (inUse) {
      return yield* Effect.fail(new InstanceInUse({ instanceId: instance.id }))
    }

    const now = yield* Clock.currentTimeMillis
    const deleting = yield* Either.match(beginDeleting(instance, now), {
      onLeft: Effect.fail,
      onRight: Effect.succeed
    })
    yield* instances.update(deleting)
    return deleting
  })
