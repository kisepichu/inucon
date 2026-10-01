import { Clock, Effect, Option } from "effect"
import { Contest } from "../../domain/contest.js"
import { InvalidContestTransition } from "../../domain/errors.js"
import type { ContestId, ResourceBindingId, UserId } from "../../domain/ids.js"
import { beginDeleting, Instance, markDeleted } from "../../domain/instance.js"
import type { NewOperation, NewOperationStep, Operation, OperationStep } from "../../domain/operation.js"
import { needsCleanupOperation, stemOfHostname } from "../../domain/reconciliation.js"
import type {
  HostnameDesired,
  HostnameObservation,
  ReconciliationEntry
} from "../../domain/reconciliation.js"
import { ResourceBinding } from "../../domain/resourceBinding.js"
import type { Team } from "../../domain/team.js"
import { modeVmIdentityMismatch } from "../../domain/modeVmIds.js"
import {
  AmbiguousReconciliation,
  ContestNotFound,
  NothingToReconcile,
  ResidualManagedResource,
  StaleReconciliationPlan
} from "../errors.js"
import {
  CloudflareError,
  CloudflarePort,
  ContestRepo,
  HostnameConfig,
  InstanceRepo,
  ModeTransitionTimeout,
  OperationExecutionError,
  OperationHandler,
  OperationInProgress,
  OperationRepo,
  ProxmoxError,
  ProxmoxPort,
  RepoError,
  ResourceBindingRepo,
  TeamRepo,
  UuidGen
} from "../ports.js"
import { planReconciliation } from "./reconciliation.js"
import type { StepOutcome } from "./operations.js"

// Task 12: Access close / cleanup / return_normal_mode の 3 Operation を提供する。
//
// - closeContestAccess: `revoke_access` Operation を enqueue する。scheduler が
//   `accessClosesAt <= now AND accessClosedAt IS NULL` の Contest で呼ぶ。
//   単一 step (`revoke_access:remove_apps`) が Contest スコープの全 team
//   hostname について CloudflarePort.removeAccessApp を冪等に呼び、成功すれば
//   contests.accessClosedAt を saveIfRevision で刻む。
//
// - cleanupContestResources: `cleanup` Operation を enqueue する。admin apply
//   もしくは scheduler が `cleanupAt <= now AND cleanupCompletedAt IS NULL` で
//   呼ぶ。plan は reconciliation plan を再利用し (contest revision + inventory)、
//   per-hostname の cleanup step を continueOnError=true で並べる。最終 step
//  (`cleanup:mark_completed`) が「再観測で clean」を確認して cleanupCompletedAt を
//   刻む — 途中で 1 hostname が provider 失敗しても他 hostname の撤収は継続し、
//   最終 step は「残っている」観測結果を summary に載せて Operation を failed で終える。
//
// - returnNormalMode: `return_normal_mode` Operation を enqueue する。8 step:
//   verify_no_managed_vms → set_benchvm_onboot_0 → shutdown_benchvm →
//   wait_benchvm_stopped → memory_check → set_devvm_onboot_1 → start_devvm →
//   verify_devvm_running。verify_no_managed_vms は Proxmox listManagedVms で
//   hostname stem が inucon-team* に一致する残存 VM を検出し、あれば blocked。
//
// scheduler / handler の並走時のリトライ規則は plan spec §Step 3/4:
//   - due predicate (`accessClosedAt IS NULL` / `cleanupCompletedAt IS NULL`)
//     が本質的な at-most-once の砦。
//   - `OperationRepo.hasUnfinishedByContestAndKind` (queued/running/blocked/failed)
//     が defensive NOT EXISTS ガード。scheduler は tick ごとに再挑戦する。

export const REVOKE_ACCESS_STEP_KEY = "revoke_access:remove_apps" as const

export const CLEANUP_MARK_COMPLETED_STEP_KEY = "cleanup:mark_completed" as const

export const cleanupStepKeyFor = (hostname: string): string => `cleanup:${hostname}`

export const RETURN_NORMAL_MODE_STEP_KEYS = [
  "verify_no_managed_vms",
  "set_benchvm_onboot_0",
  "shutdown_benchvm",
  "wait_benchvm_stopped",
  "memory_check",
  "set_devvm_onboot_1",
  "start_devvm",
  "verify_devvm_running"
] as const

export type ReturnNormalModeStepKey = (typeof RETURN_NORMAL_MODE_STEP_KEYS)[number]

// spec で明示された 60 秒 graceful timeout (modeOperation.ts と同値)。
const MODE_SHUTDOWN_TIMEOUT_MILLIS = 60_000
const MODE_START_TIMEOUT_MILLIS = 60_000

// 1 GiB host reserve (readiness の memory_check と同じ根拠。modeOperation と同値)。
const HOST_MEMORY_RESERVE_BYTES = 1 * 1024 * 1024 * 1024

// --- 入口 --------------------------------------------------------------------

export type CloseContestAccessError = RepoError | ContestNotFound | OperationInProgress

// scheduler / admin どちらから呼ばれても同じ enqueue。
// spec §Step 3: `revoke_access` は「finish/cancel/finished どの状態でも」呼べる
// (accessClosedAt IS NULL の contest はすべて対象)。ここでは status を検査しない。
export const closeContestAccess = (args: {
  readonly contestId: ContestId
  readonly actor: Operation["actor"]
}): Effect.Effect<Operation, CloseContestAccessError, ContestRepo | OperationRepo> =>
  Effect.gen(function* () {
    const contests = yield* ContestRepo
    const found = yield* contests.findById(args.contestId)
    if (Option.isNone(found)) {
      return yield* Effect.fail(new ContestNotFound())
    }
    const contest = found.value

    const operations = yield* OperationRepo
    const input: NewOperation = {
      contestId: contest.id,
      kind: "revoke_access",
      actor: args.actor,
      planDigest: `revoke_access:c${contest.id}:r${contest.revision}`,
      contestRevision: contest.revision,
      steps: [
        {
          stepKey: REVOKE_ACCESS_STEP_KEY,
          ordinal: 0,
          inputSummary: JSON.stringify({ contestId: contest.id }),
          continueOnError: false
        }
      ]
    }
    return yield* operations.enqueue(input)
  })

export type CleanupRequestError =
  | RepoError
  | ContestNotFound
  | StaleReconciliationPlan
  | AmbiguousReconciliation
  | NothingToReconcile
  | OperationInProgress
  | ProxmoxError
  | CloudflareError

// cleanup Operation の step 列を組む。admin apply (cleanupContestResources) と
// scheduler (scheduleContestCleanup) は完全に同じ対象選択 + 同じ step 構成を
// 使う。以前は同じコードを 2 箇所に複製しており、対象選択条件が片側だけ更新
// される drift の温床だった (2026-10-01 の本番デッドロックはこの複製が原因)。
//
// 対象が 0 件なら空配列を返す。呼び出し元は NothingToReconcile に落とす
// — mark_completed だけの Operation を積んでも何も撤収しないため。
const buildCleanupSteps = (args: {
  readonly contestId: ContestId
  readonly entries: ReadonlyArray<ReconciliationEntry>
}): ReadonlyArray<NewOperationStep> => {
  // entries は hostname 単位で一意 (collectPlan が hostname 集合から作る)。
  const hostnames = args.entries
    .filter(needsCleanupOperation)
    .map((e) => e.hostname)
    .sort()
  if (hostnames.length === 0) return []
  const steps: Array<NewOperationStep> = hostnames.map((hostname, i) => ({
    stepKey: cleanupStepKeyFor(hostname),
    ordinal: i,
    inputSummary: JSON.stringify({ hostname, contestId: args.contestId }),
    // spec §Step 4: per-hostname は continueOnError=true。1 hostname の
    // provider 失敗が他の独立 hostname を止めない。
    continueOnError: true
  }))
  steps.push({
    stepKey: CLEANUP_MARK_COMPLETED_STEP_KEY,
    ordinal: hostnames.length,
    inputSummary: JSON.stringify({ contestId: args.contestId }),
    // 最終 step は失敗を halt にする — reconciliation が clean でなければ
    // Operation を failed にして operator 判断を待つ。
    continueOnError: false
  })
  return steps
}

// admin の explicit apply が呼ぶ入口 (scheduler は下記 scheduleContestCleanup で
// planDigest を計算する)。reconciliation apply と同型に「planDigest 一致 +
// blocked=0 + actionable>=1」を検証し、cleanup の per-hostname step +
// mark_completed 最終 step を Operation として enqueue する。
export const cleanupContestResources = (args: {
  readonly contestId: ContestId
  readonly planDigest: string
  readonly actorUserId: UserId
}): Effect.Effect<
  Operation,
  CleanupRequestError,
  ContestRepo | InstanceRepo | ResourceBindingRepo | TeamRepo | ProxmoxPort | CloudflarePort | OperationRepo
> =>
  Effect.gen(function* () {
    // reconciliation plan と同じ「hostname 単位の分類」を再利用する。cleanup と
    // reconciliation は同じ desired/observed を見る (spec §Reconciliation) ため。
    const plan = yield* planReconciliation({
      contestId: args.contestId,
      adoptHostnames: []
    })
    if (plan.planDigest !== args.planDigest) {
      return yield* Effect.fail(new StaleReconciliationPlan())
    }
    const blocked = plan.entries.filter((e) => e.action === "blocked").map((e) => e.hostname)
    if (blocked.length > 0) {
      return yield* Effect.fail(new AmbiguousReconciliation({ hostnames: blocked }))
    }
    const steps = buildCleanupSteps({ contestId: args.contestId, entries: plan.entries })
    if (steps.length === 0) {
      return yield* Effect.fail(new NothingToReconcile())
    }

    const operations = yield* OperationRepo
    return yield* operations.enqueue({
      contestId: args.contestId,
      kind: "cleanup",
      actor: { kind: "admin", userId: args.actorUserId },
      planDigest: plan.planDigest,
      contestRevision: plan.contestRevision,
      steps
    })
  })

// scheduler が呼ぶ「planDigest 事前計算 + enqueue」バリアント。admin と違い
// planDigest はサーバ側で決めてよいので、plan digest 一致検証を経ずに直接
// enqueue する。
export const scheduleContestCleanup = (args: {
  readonly contestId: ContestId
}): Effect.Effect<
  Operation,
  RepoError | ContestNotFound | NothingToReconcile | OperationInProgress | ProxmoxError | CloudflareError | AmbiguousReconciliation,
  ContestRepo | InstanceRepo | ResourceBindingRepo | TeamRepo | ProxmoxPort | CloudflarePort | OperationRepo
> =>
  Effect.gen(function* () {
    const plan = yield* planReconciliation({
      contestId: args.contestId,
      adoptHostnames: []
    })
    const blocked = plan.entries.filter((e) => e.action === "blocked").map((e) => e.hostname)
    if (blocked.length > 0) {
      return yield* Effect.fail(new AmbiguousReconciliation({ hostnames: blocked }))
    }
    const steps = buildCleanupSteps({ contestId: args.contestId, entries: plan.entries })
    if (steps.length === 0) {
      return yield* Effect.fail(new NothingToReconcile())
    }
    const operations = yield* OperationRepo
    return yield* operations.enqueue({
      contestId: args.contestId,
      kind: "cleanup",
      actor: { kind: "scheduler" },
      planDigest: plan.planDigest,
      contestRevision: plan.contestRevision,
      steps
    })
  })

export type ReturnNormalModeError =
  | RepoError
  | ContestNotFound
  | OperationInProgress
  | ResidualManagedResource
  | ProxmoxError

// 前 gate: 「まだ managed VM が Proxmox に残っている」= cleanup 未完了。
// spec §Step 5: 「Any residual VM/resource blocks the first step.」
// enqueue 前にも先に読んで 409 に落とせるようにする (handler は同じ判定を
// 実行時にも再観測して blocked にする)。
export const returnNormalMode = (args: {
  readonly contestId: ContestId
  readonly actorUserId: UserId
}): Effect.Effect<Operation, ReturnNormalModeError | InvalidContestTransition, ContestRepo | OperationRepo | ProxmoxPort> =>
  Effect.gen(function* () {
    const contests = yield* ContestRepo
    const found = yield* contests.findById(args.contestId)
    if (Option.isNone(found)) {
      return yield* Effect.fail(new ContestNotFound())
    }
    const contest = found.value
    // review round 3 #2: contest がまだ running 等の live 状態のうちに
    // return_normal_mode を呼ぶと benchvm shutdown が走って参加者経路が切れる。
    // finished / canceled 以外は拒否する (managed VM 0 件でも意図しない admin
    // 誤操作を弾く)。
    if (contest.status !== "finished" && contest.status !== "canceled") {
      return yield* Effect.fail(
        new InvalidContestTransition({ from: contest.status, to: "finished" })
      )
    }
    const px = yield* ProxmoxPort
    const managed = yield* px.listManagedVms
    if (managed.length > 0) {
      return yield* Effect.fail(
        // review round 2 #3: stem に落ちない name は infrastructure VM 等の
        // 想定外なので、error payload には載せない (raw VM 名の情報漏えい防止)。
        new ResidualManagedResource({
          hostnames: managed
            .map((v) => stemOfHostname(v.name))
            .filter((s): s is string => s !== null)
        })
      )
    }
    const operations = yield* OperationRepo
    const steps = RETURN_NORMAL_MODE_STEP_KEYS.map((key, i) => ({
      stepKey: key,
      ordinal: i,
      inputSummary: JSON.stringify({ contestId: contest.id }),
      continueOnError: false
    }))
    return yield* operations.enqueue({
      contestId: contest.id,
      kind: "return_normal_mode",
      actor: { kind: "admin", userId: args.actorUserId },
      planDigest: `return_normal_mode:c${contest.id}:r${contest.revision}`,
      contestRevision: contest.revision,
      steps
    })
  })

// --- Handler: revoke_access -------------------------------------------------

interface StepInputContest {
  readonly contestId: ContestId
}

const parseContestStepInput = (raw: string): StepInputContest | null => {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== "object" || parsed === null) return null
    const cid = (parsed as Record<string, unknown>).contestId
    if (typeof cid !== "string") return null
    return { contestId: cid as ContestId }
  } catch {
    return null
  }
}

// revoke_access step: Contest スコープの全 team hostname について
// CloudflarePort.removeAccessApp を冪等に呼ぶ。全 hostname 成功後に
// Contest.accessClosedAt を刻む (saveIfRevision で revision +1)。
export const makeRevokeAccessHandler: Effect.Effect<
  OperationHandler,
  never,
  CloudflarePort | ContestRepo | HostnameConfig | InstanceRepo | TeamRepo
> = Effect.gen(function* () {
  const context = yield* Effect.context<
    CloudflarePort | ContestRepo | HostnameConfig | InstanceRepo | TeamRepo
  >()
  const run = (step: OperationStep): Effect.Effect<StepOutcome, OperationExecutionError> =>
    Effect.gen(function* () {
      const parsed = parseContestStepInput(step.inputSummary)
      if (parsed === null) {
        return { status: "blocked", summary: "invalid_step_input" } satisfies StepOutcome
      }
      const contests = yield* ContestRepo
      const found = yield* contests.findById(parsed.contestId)
      if (Option.isNone(found)) {
        return { status: "blocked", summary: "contest_not_found" } satisfies StepOutcome
      }
      const contest = found.value
      // 既に accessClosedAt が刻まれていれば冪等成功 (scheduler が同時 tick で
      // 二重に来る場合の再入補償)。
      if (Option.isSome(contest.accessClosedAt)) {
        return { status: "succeeded", summary: "access_already_closed" } satisfies StepOutcome
      }

      const teams = yield* TeamRepo
      const instances = yield* InstanceRepo
      const cf = yield* CloudflarePort
      const hostnameConfig = yield* HostnameConfig

      const teamList = yield* teams.listByContest(contest.id)
      const instList = yield* instances.listByContest(contest.id)
      const teamByIdMap = new Map<string, Team>(teamList.map((t) => [t.id, t] as const))
      const hostnames = new Set<string>()
      for (const inst of instList) {
        const team = teamByIdMap.get(inst.teamId)
        if (team === undefined) continue
        hostnames.add(`inucon-team${team.teamNumber}-${inst.index}`)
      }

      // hostname が 1 件も無ければ「access を撤去すべき resource が無い」= 冪等成功。
      for (const h of hostnames) {
        const fqdn = `${h}.${hostnameConfig.zoneName}`
        yield* cf.removeAccessApp(fqdn)
      }

      const now = yield* Clock.currentTimeMillis
      yield* contests.saveIfRevision(
        new Contest({
          ...contest,
          accessClosedAt: Option.some(now),
          revision: contest.revision + 1
        }),
        contest.revision
      )
      return {
        status: "succeeded",
        summary: `revoked access for ${hostnames.size} hostname(s)`
      } satisfies StepOutcome
    }).pipe(
      Effect.provide(context),
      // provider / repo 失敗は sanitize_operation_error 経由で worker が retry 判定する。
      // ContestRevisionConflict は「別 admin が同時に Contest を書き換えた」= 一時失敗として retry。
      Effect.catchTag("ContestRevisionConflict", (cause) =>
        Effect.fail(new OperationExecutionError({ cause }))
      ),
      Effect.catchTag("CloudflareError", (cause) =>
        Effect.fail(new OperationExecutionError({ cause }))
      ),
      Effect.catchTag("RepoError", (cause) =>
        Effect.fail(new OperationExecutionError({ cause }))
      ),
      Effect.catchAllDefect((defect) =>
        Effect.fail(new OperationExecutionError({ cause: defect }))
      )
    )
  return { run }
})

// --- Handler: cleanup -------------------------------------------------------

interface CleanupHostnameInput {
  readonly hostname: string
  readonly contestId: ContestId
}

const parseCleanupInput = (raw: string): CleanupHostnameInput | null => {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== "object" || parsed === null) return null
    const rec = parsed as Record<string, unknown>
    if (typeof rec.hostname !== "string") return null
    if (typeof rec.contestId !== "string") return null
    return { hostname: rec.hostname, contestId: rec.contestId as ContestId }
  } catch {
    return null
  }
}

// hostname 単位の cleanup step: Proxmox VM を destroy → CF DNS + Access を撤去 →
// binding を削除 → Instance を deleted に落とす。すべて冪等 (removeInstanceRoute /
// removeAccessApp / stopAndDestroyVm はすべて存在しない場合も成功扱いの契約)。
const runCleanupHostname = (
  input: CleanupHostnameInput
): Effect.Effect<
  StepOutcome,
  OperationExecutionError,
  CloudflarePort
  | HostnameConfig
  | InstanceRepo
  | ProxmoxPort
  | ResourceBindingRepo
  | TeamRepo
> =>
  Effect.gen(function* () {
    const px = yield* ProxmoxPort
    const cf = yield* CloudflarePort
    const bindings = yield* ResourceBindingRepo
    const instances = yield* InstanceRepo
    const teams = yield* TeamRepo
    const hostnameConfig = yield* HostnameConfig

    // 現状観測: Proxmox 側 VM が存在するか。存在すれば destroy を呼ぶ。
    // duplicate ambiguity は「別 hostname 名の重複」ではなく VMID 重複だが、
    // listManagedVms は name で filter しているので同名 VM が複数返る場合が
    // ambiguous — その場合は blocked。
    const managed = yield* px.listManagedVms
    const matching = managed.filter((v) => v.name === input.hostname)
    if (matching.length > 1) {
      return { status: "blocked", summary: `ambiguous_vm:${input.hostname}` } satisfies StepOutcome
    }
    for (const vm of matching) {
      yield* px.stopAndDestroyVm(vm.vmid)
    }

    const fqdn = `${input.hostname}.${hostnameConfig.zoneName}`
    yield* cf.removeInstanceRoute(fqdn)
    yield* cf.removeAccessApp(fqdn)

    // Contest scope の全 binding のうち canonicalKey==hostname を削除する。
    // provider は cloudflare / proxmox いずれも掃除する (Task 7 follow-up)。
    const contestBindings = yield* bindings.listByContest(input.contestId)
    for (const binding of contestBindings) {
      if (binding.canonicalKey === input.hostname) {
        yield* bindings.deleteById(binding.id)
      }
    }

    // Instance を deleted に落とす (running/failed → deleting → deleted)。
    // stemOfHostname は "inucon-teamN-M" → team/index を復元する必要があるが、
    // より単純には teamRepo + instanceRepo から (teamNumber, index) 一致で解決する。
    const teamList = yield* teams.listByContest(input.contestId)
    const instList = yield* instances.listByContest(input.contestId)
    const teamByNumber = new Map<number, Team>(teamList.map((t) => [t.teamNumber, t] as const))
    const now = yield* Clock.currentTimeMillis
    const match = input.hostname.match(/^inucon-team(\d+)-(\d+)$/)
    if (match !== null) {
      const teamNumber = Number.parseInt(match[1], 10)
      const index = Number.parseInt(match[2], 10)
      const team = teamByNumber.get(teamNumber)
      if (team !== undefined) {
        const targetInstances = instList.filter(
          (i) => i.teamId === team.id && i.index === index && i.status !== "deleted"
        )
        for (const inst of targetInstances) {
          if (inst.status === "running" || inst.status === "failed") {
            const deleting = beginDeleting(inst, now)
            if (deleting._tag === "Right") {
              yield* instances.update(deleting.right)
              const deleted = markDeleted(deleting.right, now)
              if (deleted._tag === "Right") {
                yield* instances.update(deleted.right)
              }
            }
          } else if (inst.status === "deleting") {
            const deleted = markDeleted(inst, now)
            if (deleted._tag === "Right") {
              yield* instances.update(deleted.right)
            }
          }
          // creating: 素直に deleted に落とす (saga 途中の compensating には
          // Provisioner が対応するが、cleanup 段階では単に deleted マークで済ませる)。
          else if (inst.status === "creating") {
            // creating → deleting は beginDeleting の domain 制約で拒否される
            // (running/failed からのみ)。ここでは update で強制的に deleted に落とす
            // (cleanup の最終責務: 「実体撤収済み」に台帳を揃える)。
            yield* instances.update(
              new Instance({ ...inst, status: "deleted", updatedAt: now })
            )
          }
        }
      }
    }

    return { status: "succeeded", summary: `cleaned ${input.hostname}` } satisfies StepOutcome
  }).pipe(
    Effect.catchTag("ProxmoxError", (cause) => Effect.fail(new OperationExecutionError({ cause }))),
    Effect.catchTag("CloudflareError", (cause) =>
      Effect.fail(new OperationExecutionError({ cause }))
    ),
    Effect.catchTag("RepoError", (cause) => Effect.fail(new OperationExecutionError({ cause }))),
    Effect.catchAllDefect((defect) =>
      Effect.fail(new OperationExecutionError({ cause: defect }))
    )
  )

// hostname → desired/observation を組み立てる (reconciliation.ts の同型 helper と
// 同じロジックだが、cleanup 最終 step 専用の狭い版を持つ — reconciliation.ts の
// export は internal で application 層越しに import しない方針)。
const buildDesiredForContest = (args: {
  readonly teams: ReadonlyArray<Team>
  readonly instances: ReadonlyArray<Instance>
  readonly bindings: ReadonlyArray<ResourceBinding>
  readonly contestId: ContestId
}): Map<string, HostnameDesired> => {
  const teamById = new Map(args.teams.map((t) => [t.id, t] as const))
  const map = new Map<string, HostnameDesired>()
  for (const instance of args.instances) {
    const team = teamById.get(instance.teamId)
    if (team === undefined) continue
    const hostname = `inucon-team${team.teamNumber}-${instance.index}`
    map.set(hostname, {
      hostname,
      contestId: args.contestId,
      teamId: Option.some(team.id),
      instanceId: Option.some(instance.id),
      instanceStatus: Option.some(instance.status),
      cloudflareBindingIds: [],
      proxmoxBindingIds: []
    })
  }
  for (const binding of args.bindings) {
    const hostname = binding.canonicalKey
    const existing = map.get(hostname) ?? {
      hostname,
      contestId: args.contestId,
      teamId: binding.teamId,
      instanceId: binding.instanceId,
      instanceStatus: Option.none(),
      cloudflareBindingIds: [] as ReadonlyArray<ResourceBindingId>,
      proxmoxBindingIds: [] as ReadonlyArray<ResourceBindingId>
    }
    map.set(
      hostname,
      binding.provider === "cloudflare"
        ? { ...existing, cloudflareBindingIds: [...existing.cloudflareBindingIds, binding.id] }
        : binding.provider === "proxmox"
        ? { ...existing, proxmoxBindingIds: [...existing.proxmoxBindingIds, binding.id] }
        : existing
    )
  }
  return map
}

const buildObservationForContest = (args: {
  readonly proxmoxVms: ReadonlyArray<{ vmid: number; name: string; status: "running" | "stopped" }>
  readonly cfInventory: {
    readonly routes: ReadonlyArray<{ hostname: string; dnsRecordIds: ReadonlyArray<string>; ingressServices: ReadonlyArray<string> }>
    readonly apps: ReadonlyArray<{ hostname: string; appIds: ReadonlyArray<string> }>
  }
}): Map<string, HostnameObservation> => {
  const map = new Map<string, HostnameObservation>()
  const ensure = (hostname: string): HostnameObservation => {
    const cur = map.get(hostname)
    if (cur !== undefined) return cur
    const created: HostnameObservation = {
      hostname,
      proxmoxVm: Option.none(),
      cloudflareRouteCount: 0,
      cloudflareIngressCount: 0,
      cloudflareAppCount: 0
    }
    map.set(hostname, created)
    return created
  }
  for (const vm of args.proxmoxVms) {
    const stem = stemOfHostname(vm.name)
    if (stem === null) continue
    map.set(stem, { ...ensure(stem), proxmoxVm: Option.some({ vmid: vm.vmid, status: vm.status }) })
  }
  for (const r of args.cfInventory.routes) {
    const stem = stemOfHostname(r.hostname)
    if (stem === null) continue
    map.set(stem, {
      ...ensure(stem),
      cloudflareRouteCount: r.dnsRecordIds.length,
      cloudflareIngressCount: r.ingressServices.length
    })
  }
  for (const a of args.cfInventory.apps) {
    const stem = stemOfHostname(a.hostname)
    if (stem === null) continue
    map.set(stem, { ...ensure(stem), cloudflareAppCount: a.appIds.length })
  }
  return map
}

// mark_completed step: reconciliation 再観測が clean (未撤収 hostname が無い)
// なら Contest.cleanupCompletedAt を刻む。まだ blocked / cleanup entry があれば
// 「residual があります」で blocked (Operation は failed に落ちる — spec:
// 「ends failed after all runnable cleanup steps ran but reconciliation is
// still dirty」)。
const runMarkCleanupCompleted = (
  input: StepInputContest
): Effect.Effect<
  StepOutcome,
  OperationExecutionError,
  | ContestRepo
  | InstanceRepo
  | ResourceBindingRepo
  | TeamRepo
  | ProxmoxPort
  | CloudflarePort
> =>
  Effect.gen(function* () {
    const contests = yield* ContestRepo
    const teams = yield* TeamRepo
    const instances = yield* InstanceRepo
    const bindings = yield* ResourceBindingRepo
    const px = yield* ProxmoxPort
    const cf = yield* CloudflarePort

    const found = yield* contests.findById(input.contestId)
    if (Option.isNone(found)) {
      return { status: "blocked", summary: "contest_not_found" } satisfies StepOutcome
    }
    const contest = found.value
    if (Option.isSome(contest.cleanupCompletedAt)) {
      return { status: "succeeded", summary: "already_completed" } satisfies StepOutcome
    }

    const [teamList, instList, bindingList, managed, cfInv] = yield* Effect.all([
      teams.listByContest(input.contestId),
      instances.listByContest(input.contestId),
      bindings.listByContest(input.contestId),
      px.listManagedVms,
      cf.getInstanceInventory
    ])

    const desired = buildDesiredForContest({
      teams: teamList,
      instances: instList,
      bindings: bindingList,
      contestId: input.contestId
    })
    const observation = buildObservationForContest({
      proxmoxVms: managed,
      cfInventory: cfInv
    })

    // review round 2 #2: mark_completed は「この Contest の hostname」だけを
    // 見る。listManagedVms / getInstanceInventory は node 全体を返すため、
    // 別 Contest 由来の観測が false-positive に混ざるのを避けるため、対象
    // hostname 集合は desired (この Contest 由来) に限定する。observation は
    // 「desired hostname に対応する観測」だけを引き当てる。
    // reconciliation の in_sync 判定は「VM + CF resource が揃っている」= "運用中" を
    // clean 扱いにするが、cleanup 完了判定では逆に「何も残っていない」= clean。
    // - VM 実在 (proxmoxVm=Some) → 未撤収
    // - CF DNS / ingress / Access が 1 つでもある → 未撤収
    // - ResourceBinding が 1 件でもある → 未撤収
    // - Instance が deleted 以外 (running / creating / deleting / failed) → 未撤収
    const residual: Array<string> = []
    for (const h of desired.keys()) {
      const obs = observation.get(h)
      const des = desired.get(h)!
      const cfCount =
        (obs?.cloudflareRouteCount ?? 0) +
        (obs?.cloudflareIngressCount ?? 0) +
        (obs?.cloudflareAppCount ?? 0)
      const vmExists = obs !== undefined && Option.isSome(obs.proxmoxVm)
      const bindingCount = des.cloudflareBindingIds.length + des.proxmoxBindingIds.length
      const instanceActive = Option.match(des.instanceStatus, {
        onNone: () => false,
        onSome: (status) => status !== "deleted"
      })
      if (vmExists || cfCount > 0 || bindingCount > 0 || instanceActive) {
        residual.push(h)
      }
    }
    if (residual.length > 0) {
      return {
        status: "blocked",
        summary: `residual_hostnames:${residual.sort().join(",")}`
      } satisfies StepOutcome
    }

    const now = yield* Clock.currentTimeMillis
    yield* contests.saveIfRevision(
      new Contest({
        ...contest,
        cleanupCompletedAt: Option.some(now),
        revision: contest.revision + 1
      }),
      contest.revision
    )
    return { status: "succeeded", summary: "cleanup_completed" } satisfies StepOutcome
  }).pipe(
    Effect.catchTag("ProxmoxError", (cause) => Effect.fail(new OperationExecutionError({ cause }))),
    Effect.catchTag("CloudflareError", (cause) =>
      Effect.fail(new OperationExecutionError({ cause }))
    ),
    Effect.catchTag("RepoError", (cause) => Effect.fail(new OperationExecutionError({ cause }))),
    Effect.catchTag("ContestRevisionConflict", (cause) =>
      Effect.fail(new OperationExecutionError({ cause }))
    ),
    Effect.catchAllDefect((defect) =>
      Effect.fail(new OperationExecutionError({ cause: defect }))
    )
  )

export const makeCleanupHandler: Effect.Effect<
  OperationHandler,
  never,
  | CloudflarePort
  | ContestRepo
  | HostnameConfig
  | InstanceRepo
  | ProxmoxPort
  | ResourceBindingRepo
  | TeamRepo
> = Effect.gen(function* () {
  const context = yield* Effect.context<
    | CloudflarePort
    | ContestRepo
    | HostnameConfig
    | InstanceRepo
    | ProxmoxPort
    | ResourceBindingRepo
    | TeamRepo
  >()
  const run = (step: OperationStep): Effect.Effect<StepOutcome, OperationExecutionError> =>
    Effect.gen(function* () {
      if (step.stepKey === CLEANUP_MARK_COMPLETED_STEP_KEY) {
        const parsed = parseContestStepInput(step.inputSummary)
        if (parsed === null) {
          return { status: "blocked", summary: "invalid_step_input" } satisfies StepOutcome
        }
        return yield* runMarkCleanupCompleted(parsed)
      }
      const parsed = parseCleanupInput(step.inputSummary)
      if (parsed === null) {
        return { status: "blocked", summary: "invalid_step_input" } satisfies StepOutcome
      }
      return yield* runCleanupHostname(parsed)
    }).pipe(Effect.provide(context))
  return { run }
})

// --- Handler: return_normal_mode -------------------------------------------

const succeeded = (summary: string): StepOutcome => ({ status: "succeeded", summary })
const blocked = (summary: string): StepOutcome => ({ status: "blocked", summary })

export const makeReturnNormalModeHandler: Effect.Effect<OperationHandler, never, ProxmoxPort> =
  Effect.gen(function* () {
    const px = yield* ProxmoxPort

    const runStep = (step: OperationStep): Effect.Effect<StepOutcome, OperationExecutionError> =>
      Effect.gen(function* () {
        // verify_no_managed_vms は listManagedVms しか使わない。inventory 全体を
        // 取るのは他 7 step に絞る (review round 1 finding 3: 冗長 API call)。
        if (step.stepKey === "verify_no_managed_vms") {
          const managed = yield* px.listManagedVms
          if (managed.length > 0) {
            const stems = managed
              .map((v) => stemOfHostname(v.name))
              .filter((s): s is string => s !== null)
              .sort()
            return blocked(`residual_managed_vms:${stems.join(",")}`)
          }
          return succeeded("no managed VMs remain")
        }

        // 残り step は毎回 inventory を再観測する (modeOperation.ts と同型)。
        const inv = yield* px.getInfrastructureInventory

        // inventory の各フィールドは独立に観測可能/不能。devvm / benchvm が
        // 観測できなければ identity 検証ができないので fail-closed に blocked。
        const devvm = Option.getOrNull(inv.devvm)
        const benchvm = Option.getOrNull(inv.benchvm)
        if (devvm === null || benchvm === null) {
          return blocked(
            "devvm/benchvm are not observable in the Proxmox inventory; " +
              "verify the mode credential ACL and /vms mapping before any power operation"
          )
        }

        // fail-closed な VMID mapping 検証(modeOperation.ts と同型)。
        // return_normal_mode は「benchvm を止めて devvm を起動」するので、
        // mapping がズレていると開発サーバを落として bench runner を起動する。
        // observed name が期待値と一致しない限り power 操作を一切発行せず
        // blocked に落とす(retry しない)。
        const identityMismatch = modeVmIdentityMismatch({ devvm, benchvm })
        if (identityMismatch !== null) return blocked(identityMismatch)

        switch (step.stepKey) {
          // onboot の冪等ショートカットは観測が確定している(Some)ときだけ
          // (modeOperation.ts と同型)。None を「already」とみなすと benchvm の
          // onboot=1 が残り、eevee 再起動で devvm と両方が自動起動しうる。
          case "set_benchvm_onboot_0": {
            if (Option.contains(benchvm.onBoot, false)) return succeeded("benchvm.onBoot already 0")
            yield* px.setVmOnBoot(benchvm.vmid, false)
            return succeeded("benchvm.onBoot set to 0")
          }
          case "shutdown_benchvm": {
            if (benchvm.status === "stopped") return succeeded("benchvm already stopped")
            yield* px.shutdownVm(benchvm.vmid)
            return succeeded("benchvm guest shutdown issued")
          }
          case "wait_benchvm_stopped": {
            if (benchvm.status === "stopped") return succeeded("benchvm already stopped")
            const result = yield* Effect.either(
              px.waitForVmStatus(benchvm.vmid, "stopped", MODE_SHUTDOWN_TIMEOUT_MILLIS)
            )
            if (result._tag === "Right") return succeeded("benchvm reached stopped")
            if (result.left instanceof ModeTransitionTimeout) {
              return blocked(
                `benchvm guest shutdown did not complete within ${MODE_SHUTDOWN_TIMEOUT_MILLIS}ms; ` +
                  `verify guest agent then run 'qm shutdown ${benchvm.vmid}' manually (do not force stop)`
              )
            }
            return yield* Effect.fail(new OperationExecutionError({ cause: result.left }))
          }
          case "memory_check": {
            // devvm が既に running なら起動用の空きは要らない (通常モード中の押し直し)。
            // nodeFree は devvm の RAM を既に控除済みなので、ここで devvm 分を要求すると
            // 二重控除で blocked になり、global lock を握ったまま次回開催の「準備開始」を
            // 止める (enter_contest_mode の memory_check と対称)。
            // 短絡は安全: step は ordinal 順に厳密に直列実行され (PR #86)、この後に残るのは
            // set_devvm_onboot_1 (VM config の書き込みのみ) / start_devvm /
            // verify_devvm_running だけ。後 2 つは毎 step 再観測した devvm が running なら
            // 何も発行しないので、新たにメモリを確保する step は無い。
            if (devvm.status === "running") return succeeded("devvm already running")
            // post-shutdown MemAvailable + benchvm 停止で解放される RAM が
            // devvm 起動要求 + host reserve を満たすか。既に benchvm が
            // stopped なら加算しない。
            const nodeFreeMemBytes = Option.getOrNull(inv.nodeFreeMemBytes)
            if (nodeFreeMemBytes === null) {
              return blocked("node free memory is not observable in the Proxmox inventory; cannot verify headroom")
            }
            const benchvmReleasable = benchvm.status === "running" ? benchvm.memoryBytes : 0
            const projected = nodeFreeMemBytes + benchvmReleasable
            const required = devvm.memoryBytes + HOST_MEMORY_RESERVE_BYTES
            return projected >= required
              ? succeeded(
                  `post-shutdown MemAvailable ${projected}B ≥ devvm(${devvm.memoryBytes}B) + reserve(${HOST_MEMORY_RESERVE_BYTES}B)`
                )
              : blocked(
                  `post-shutdown MemAvailable ${projected}B < devvm(${devvm.memoryBytes}B) + reserve(${HOST_MEMORY_RESERVE_BYTES}B); ` +
                    "check other workloads on the node before retrying"
                )
          }
          case "set_devvm_onboot_1": {
            if (Option.contains(devvm.onBoot, true)) return succeeded("devvm.onBoot already 1")
            yield* px.setVmOnBoot(devvm.vmid, true)
            return succeeded("devvm.onBoot set to 1")
          }
          case "start_devvm": {
            if (devvm.status === "running") return succeeded("devvm already running")
            yield* px.startVm(devvm.vmid)
            return succeeded("devvm start issued")
          }
          case "verify_devvm_running": {
            if (devvm.status === "running") return succeeded("devvm already running")
            const result = yield* Effect.either(
              px.waitForVmStatus(devvm.vmid, "running", MODE_START_TIMEOUT_MILLIS)
            )
            if (result._tag === "Right") return succeeded("devvm reached running")
            if (result.left instanceof ModeTransitionTimeout) {
              return blocked(
                `devvm did not reach running within ${MODE_START_TIMEOUT_MILLIS}ms; ` +
                  `verify manually with 'qm start ${devvm.vmid}' and inspect boot logs`
              )
            }
            return yield* Effect.fail(new OperationExecutionError({ cause: result.left }))
          }
          default:
            return blocked(`unknown return_normal_mode step key: ${step.stepKey}`)
        }
      }).pipe(
        Effect.catchTag("ProxmoxError", (cause) =>
          Effect.fail(new OperationExecutionError({ cause }))
        ),
        Effect.catchAllDefect((defect) =>
          Effect.fail(new OperationExecutionError({ cause: defect }))
        )
      )

    return { run: runStep }
  })
