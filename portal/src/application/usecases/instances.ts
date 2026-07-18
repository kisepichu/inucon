import { Clock, Effect, Either, Option } from "effect"
import { validateBenchTarget } from "../../domain/subnet.js"
import { InvalidInstanceTransition } from "../../domain/errors.js"
import { InstanceId, TeamId } from "../../domain/ids.js"
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
export const requestCreateInstance = (args: { user: User; teamId: TeamId }) =>
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

    // index はサーバー側で採番する(Task 6 レビュー #1、#A): vmid = 1000 +
    // teamNumber*100 + index / ipFor = 10.100.<tn>.1<index> という不変条件は
    // index が小さい(概ね < 100)ことを前提にしており、クライアント指定の
    // index を無検証で使うと衝突・不正 IP に到達しうる。
    //
    // 注意(Task 6 レビュー #A): quota チェックは creating+running の「数」しか
    // 見ていないため、「1..instanceQuota の範囲には必ず未使用の index がある」
    // とは言えない。failed/deleting の行も同じ index を(削除されるまで)
    // 占有し続けるため、除外対象は creating/running だけでなく deleted 以外の
    // 全ステータス(creating/running/deleting/failed)にする必要がある。
    // そうしないと failed 行の index が新規作成に再利用され、後でその failed
    // 行を削除した際に新しいインスタンスの vmid/IP を共有する VM ごと壊してし
    // まう(vmid/IP 衝突・意図しない VM 破壊)。
    const occupiedIndices = new Set(existing.filter((x) => x.status !== "deleted").map((x) => x.index))
    // vmid = 1000 + teamNumber*100 + index / IP 末尾 = 1<index> という不変条件を
    // 保つため、index はチーム間で 100 を跨がない(< 100)範囲に収める。IP の
    // 末尾オクテット 1<index> も index ≤ 99 なら 11..199 の範囲に収まり有効。
    const MAX_INSTANCE_INDEX = 99
    let index: number | undefined
    for (let i = 1; i <= MAX_INSTANCE_INDEX; i++) {
      if (!occupiedIndices.has(i)) {
        index = i
        break
      }
    }
    if (index === undefined) {
      // スロット枯渇の安全弁(実運用では ~99 件の非 deleted インスタンスが
      // 同時に存在する必要があり、事実上到達不能)。最も近い既存エラーである
      // QuotaExceeded を流用する。
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
      teamId: team.id,
      index,
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
// (対象 IP が偶然一致するケースを含め、単純さを優先)。存在しない
// instanceId は「他チームのインスタンス」と同じ Forbidden として扱う
// (cancelBench と同様、ID の存在有無を漏らさない)。
//
// ガード順序: authz → 対象自身の状態ガード(InvalidInstanceTransition、
// 事前チェック) → bench 使用中ガード(InstanceInUse) → 原子的な
// beginDeletingIfAllowed(チーム全体の進行中1本ガード込み)、の順。authz を
// 最初に置くのは他エンドポイントと同じく「他チームの情報の有無を漏らさない」
// ため。対象自身の状態ガードを次に置くのは、それ自体が
// creating/deleting/deleted であれば以降のチェックをするまでもなく 409 が
// 確定するため(無駄な listByTeam/UPDATE を避ける fail-fast)。bench
// 使用中ガードはその後(対象 IP の実利用状況の局所的な確認)。
//
// 原子性(Task 6 レビュー #B、TOCTOU 修正): スペック §Instance 集約
// 不変条件2(チームにつき進行中の creating/deleting は高々1件)を守るための
// 「対象以外に creating/deleting が無いこと」チェックは、旧実装では
// listByTeam で読んでから update する二段階で行っていた(Task 6 レビュー
// #4)。これだと二つの並行削除リクエスト(または作成と削除の競合)が両方とも
// 読み取りを通過し、両方が deleting へ書き込めてしまう(不変条件違反)。
// InstanceRepo.beginDeletingIfAllowed が「対象行が running/failed」「チーム
// に対象以外の creating/deleting が無い」を単一の原子的 UPDATE 文で検証する
// ため、ここではその結果だけを見る。0 行更新(None)の場合は再読み込みして
// 原因を優先順位(対象不在 → 対象の状態が running/failed でなくなった →
// 他の進行中に競り負けた)で判定し、対応する型付きエラーを返す。
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
    const updated = yield* instances.beginDeletingIfAllowed(instance.id, now)
    if (Option.isSome(updated)) {
      return updated.value
    }

    // 原子的な UPDATE が 0 行(競合または競合状態の変化)。再読み込みして
    // 「呼び出し元に返すエラー種別を選ぶためだけ」に原因を判定する(実際の
    // 許可判定は上の単一原子的操作が行っている、createIfAllowed と同じ方針)。
    const recheck = yield* instances.findById(instance.id)
    if (Option.isNone(recheck)) {
      // findById 直後の行なので通常は起こらないが、既存の「存在有無を漏らさ
      // ない」方針に倣い Forbidden とする。
      return yield* Effect.fail(new Forbidden())
    }
    if (recheck.value.status !== "running" && recheck.value.status !== "failed") {
      return yield* Effect.fail(
        new InvalidInstanceTransition({ instanceId: recheck.value.id, from: recheck.value.status, to: "deleting" })
      )
    }
    return yield* Effect.fail(new ProvisionInProgress({ teamId: instance.teamId }))
  })
