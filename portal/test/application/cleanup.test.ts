import { it } from "@effect/vitest"
import type { Contest } from "../../src/domain/contest.js"
import type { Team } from "../../src/domain/team.js"
import { Effect, Exit, Layer, Option } from "effect"
import { describe, expect } from "vitest"
import { ContestId, InstanceId, ResourceBindingId, TeamId, UserId } from "../../src/domain/ids.js"
import { Instance } from "../../src/domain/instance.js"
import { OperationId, OperationStepId } from "../../src/domain/ids.js"
import { OperationStep } from "../../src/domain/operation.js"
import { ResourceBinding } from "../../src/domain/resourceBinding.js"
import {
  CloudflareError,
  CloudflarePort,
  ContestRepo,
  HostnameConfig,
  InstanceRepo,
  OperationRepo,
  ProxmoxError,
  ProxmoxPort,
  ResourceBindingRepo,
  TeamRepo
} from "../../src/application/ports.js"
import {
  cleanupContestResources,
  cleanupStepKeyFor,
  CLEANUP_MARK_COMPLETED_STEP_KEY,
  closeContestAccess,
  makeCleanupHandler,
  makeReturnNormalModeHandler,
  makeRevokeAccessHandler,
  RETURN_NORMAL_MODE_STEP_KEYS,
  returnNormalMode,
  REVOKE_ACCESS_STEP_KEY,
  scheduleContestCleanup
} from "../../src/application/usecases/cleanup.js"
import { planReconciliation } from "../../src/application/usecases/reconciliation.js"
import { ResidualManagedResource } from "../../src/application/errors.js"
import {
  makeCloudflarePortTest,
  makeContestRepoTest,
  makeInstanceRepoTest,
  makeOperationRepoTest,
  makeProxmoxPortTest,
  makeResourceBindingRepoTest,
  makeTeamRepoTest,
  TransactionRunnerTest,
  UuidGenTest
} from "../support/inMemory.js"
import { makeContest, makeTeam } from "../support/factories.js"

// Task 12 §Step 1: cleanup / access-close / return_normal_mode の観測可能な契約。
//
// - closeContestAccess は revoke_access Operation (1 step) を積む。handler は
//   Contest スコープの全 hostname について CloudflarePort.removeAccessApp を
//   冪等に呼び、Contest.accessClosedAt を刻む。
// - cleanupContestResources は planDigest 一致検証を経て per-hostname 撤収
//   steps (continueOnError=true) + 最終 mark_completed step を積む。
// - handler は Proxmox VM destroy → CF DNS/Access removal → binding 削除 →
//   Instance を deleted に落とす。すべて idempotent。
// - mark_completed step は再観測が clean のときのみ Contest.cleanupCompletedAt を
//   刻む。residual hostname があれば blocked に落として Operation を fail させる。
// - returnNormalMode は managed VM が残っているうちは前 gate (ResidualManagedResource)
//   で 409、handler の verify_no_managed_vms でも blocked。benchvm shutdown 順序 +
//   memory check → devvm start の 8 step。

const CONTEST_ID = ContestId.make("c-task12-1")
const TEAM1_ID = TeamId.make("team1-cleanup")
const INSTANCE_1_1 = InstanceId.make("i-cleanup-1-1")
const ADMIN_USER = UserId.make("u-admin-cleanup")
const BINDING_VM = ResourceBindingId.make("b-vm-1-1")
const BINDING_DNS = ResourceBindingId.make("b-dns-1-1")
const BINDING_APP = ResourceBindingId.make("b-app-1-1")

// preparing 経由で finalized (edition1 に近い) Contest を作る helper。
const finishedContest = makeContest({
  id: CONTEST_ID,
  edition: 1,
  status: "finished",
  problemRevision: "legacy-2026-07-08",
  revision: 1
})

const team1 = makeTeam({
  id: TEAM1_ID,
  contestId: CONTEST_ID,
  teamNumber: 1,
  name: "team1",
  desiredInstanceCount: 1
})

const instance1_1 = new Instance({
  id: INSTANCE_1_1,
  contestId: CONTEST_ID,
  teamId: TEAM1_ID,
  index: 1,
  vmid: 1101,
  privateIp: "10.100.1.11",
  status: "running",
  progress: ["clone_done", "configured", "started", "route_done", "access_done"],
  errorMessage: Option.none(),
  createdAt: 1000,
  updatedAt: 1000
})

const teamBindings: ReadonlyArray<ResourceBinding> = [
  new ResourceBinding({
    id: BINDING_VM,
    contestId: CONTEST_ID,
    teamId: Option.some(TEAM1_ID),
    instanceId: Option.some(INSTANCE_1_1),
    provider: "proxmox",
    resourceType: "vm",
    canonicalKey: "inucon-team1-1",
    externalId: Option.some("1101"),
    desiredState: "present",
    lastObservedState: Option.none(),
    lastObservedAt: Option.none()
  }),
  new ResourceBinding({
    id: BINDING_DNS,
    contestId: CONTEST_ID,
    teamId: Option.some(TEAM1_ID),
    instanceId: Option.some(INSTANCE_1_1),
    provider: "cloudflare",
    resourceType: "dns_record",
    canonicalKey: "inucon-team1-1",
    externalId: Option.some("dns-1"),
    desiredState: "present",
    lastObservedState: Option.none(),
    lastObservedAt: Option.none()
  }),
  new ResourceBinding({
    id: BINDING_APP,
    contestId: CONTEST_ID,
    teamId: Option.some(TEAM1_ID),
    instanceId: Option.some(INSTANCE_1_1),
    provider: "cloudflare",
    resourceType: "access_application",
    canonicalKey: "inucon-team1-1",
    externalId: Option.some("app-1"),
    desiredState: "present",
    lastObservedState: Option.none(),
    lastObservedAt: Option.none()
  })
]

interface FixtureOptions {
  readonly proxmoxVms?: ReadonlyArray<{ vmid: number; name: string; status: "running" | "stopped"; memoryBytes?: number }>
  readonly cloudflareRoutes?: ReadonlyArray<{ hostname: string; dnsRecordIds: ReadonlyArray<string>; ingressServices: ReadonlyArray<string> }>
  readonly cloudflareApps?: ReadonlyArray<{ hostname: string; appIds: ReadonlyArray<string>; policyShape: "owned_exact" | "unknown"; emailSetHash: string }>
  readonly instances?: ReadonlyArray<Instance>
  readonly teams?: ReadonlyArray<Team>
  readonly bindings?: ReadonlyArray<ResourceBinding>
  readonly cloudflareFailWith?: Partial<Record<"removeAccessApp" | "removeInstanceRoute", CloudflareError>>
  readonly proxmoxFailWith?: Partial<{ stopAndDestroyVm: ProxmoxError }>
  readonly contests?: ReadonlyArray<Contest>
}

const makeFixture = (opts: FixtureOptions = {}) => {
  const proxmox = makeProxmoxPortTest({
    managedVms:
      opts.proxmoxVms ??
      [{ vmid: 1101, name: "inucon-team1-1", status: "running" as const, memoryBytes: 4 * 1024 * 1024 * 1024 }],
    failWith: opts.proxmoxFailWith
  })
  const cloudflare = makeCloudflarePortTest({
    inventory: {
      routes:
        opts.cloudflareRoutes ??
        [{ hostname: "inucon-team1-1", dnsRecordIds: ["dns-1"], ingressServices: ["ssh://10.100.1.11:22"] }],
      apps:
        opts.cloudflareApps ??
        [{ hostname: "inucon-team1-1", appIds: ["app-1"], policyShape: "owned_exact" as const, emailSetHash: "hash-1" }]
    },
    failWith: opts.cloudflareFailWith
  })
  const bindingsLayer = makeResourceBindingRepoTest(opts.bindings ?? teamBindings)
  return {
    proxmox,
    cloudflare,
    layer: Layer.mergeAll(
      UuidGenTest,
      TransactionRunnerTest,
      makeContestRepoTest(opts.contests ?? [finishedContest]),
      makeInstanceRepoTest(opts.instances ?? [instance1_1]),
      makeTeamRepoTest({ teams: opts.teams ?? [team1], memberships: [] }),
      bindingsLayer,
      proxmox.layer,
      cloudflare.layer,
      makeOperationRepoTest().layer,
      Layer.succeed(HostnameConfig, { zoneName: "kisen.one" })
    )
  }
}

const stepOf = (key: string, payload: unknown, id = "s-x"): OperationStep =>
  new OperationStep({
    id: OperationStepId.make(id),
    operationId: OperationId.make("op-x"),
    ordinal: 0,
    stepKey: key,
    status: "queued",
    attempt: 1,
    continueOnError: false,
    retryAt: Option.none(),
    leaseExpiresAt: Option.none(),
    inputSummary: JSON.stringify(payload),
    progressJson: "{}",
    resultSummary: Option.none(),
    sanitizedError: Option.none(),
    createdAt: 0,
    startedAt: Option.none(),
    finishedAt: Option.none()
  })

// --- closeContestAccess -----------------------------------------------------

describe("closeContestAccess", () => {
  it.effect("Contest スコープの全 hostname について CloudflarePort.removeAccessApp を呼び accessClosedAt を刻む", () =>
    Effect.gen(function* () {
      const op = yield* closeContestAccess({
        contestId: CONTEST_ID,
        actor: { kind: "scheduler" }
      })
      expect(op.kind).toBe("revoke_access")
      const ops = yield* OperationRepo
      const steps = yield* ops.listSteps(op.id)
      expect(steps.map((s) => s.stepKey)).toEqual([REVOKE_ACCESS_STEP_KEY])

      // handler を直接動かす。CloudflarePort が inucon-team1-1.kisen.one に対して
      // removeAccessApp を呼び、Contest.accessClosedAt が刻まれる。
      const registry = yield* makeRevokeAccessHandler
      const outcome = yield* registry.run(
        stepOf(REVOKE_ACCESS_STEP_KEY, { contestId: CONTEST_ID })
      )
      expect(outcome.status).toBe("succeeded")

      const contests = yield* ContestRepo
      const after = yield* contests.findById(CONTEST_ID)
      if (Option.isSome(after)) {
        expect(Option.isSome(after.value.accessClosedAt)).toBe(true)
        expect(after.value.revision).toBe(2)
      }
    }).pipe(Effect.provide(makeFixture().layer))
  )

  it.effect("accessClosedAt が既に刻まれていれば冪等成功で早期 return する (再入補償)", () =>
    Effect.gen(function* () {
      const registry = yield* makeRevokeAccessHandler
      const outcome = yield* registry.run(
        stepOf(REVOKE_ACCESS_STEP_KEY, { contestId: CONTEST_ID })
      )
      expect(outcome.status).toBe("succeeded")
      expect(outcome.summary).toContain("already_closed")
    }).pipe(
      Effect.provide(
        makeFixture({
          contests: [
            makeContest({
              id: CONTEST_ID,
              edition: 1,
              status: "finished",
              revision: 3,
              accessClosedAt: Option.some(1234)
            })
          ]
        }).layer
      )
    )
  )
})

// --- cleanupContestResources -----------------------------------------------

describe("cleanupContestResources", () => {
  it.effect("plan digest が一致し hostname 対象があれば per-hostname step + mark_completed を積む", () =>
    Effect.gen(function* () {
      const plan = yield* planReconciliation({ contestId: CONTEST_ID, adoptHostnames: [] })
      const op = yield* cleanupContestResources({
        contestId: CONTEST_ID,
        planDigest: plan.planDigest,
        actorUserId: ADMIN_USER
      })
      expect(op.kind).toBe("cleanup")
      const ops = yield* OperationRepo
      const steps = yield* ops.listSteps(op.id)
      const keys = steps.map((s) => s.stepKey)
      expect(keys).toContain(cleanupStepKeyFor("inucon-team1-1"))
      expect(keys[keys.length - 1]).toBe(CLEANUP_MARK_COMPLETED_STEP_KEY)
      // per-hostname は continueOnError=true、最終 step は false。
      const perHostname = steps.find((s) => s.stepKey === cleanupStepKeyFor("inucon-team1-1"))
      const markCompleted = steps.find((s) => s.stepKey === CLEANUP_MARK_COMPLETED_STEP_KEY)
      expect(perHostname?.continueOnError).toBe(true)
      expect(markCompleted?.continueOnError).toBe(false)
    }).pipe(Effect.provide(makeFixture().layer))
  )

  it.effect("per-hostname handler が VM destroy → CF removal → binding 削除 → Instance deleted を実行する", () => {
    const fixture = makeFixture()
    return Effect.gen(function* () {
      const registry = yield* makeCleanupHandler
      const outcome = yield* registry.run(
        stepOf(cleanupStepKeyFor("inucon-team1-1"), {
          hostname: "inucon-team1-1",
          contestId: CONTEST_ID
        })
      )
      expect(outcome.status).toBe("succeeded")

      const proxmoxState = yield* fixture.proxmox.getState
      expect(proxmoxState.destroyedVmids).toContain(1101)
      // Instance が deleted に落ちている
      const instances = yield* InstanceRepo
      const after = yield* instances.listByContest(CONTEST_ID)
      expect(after.find((i) => i.id === INSTANCE_1_1)?.status).toBe("deleted")
      // binding が全削除される (cloudflare / proxmox 両方)
      const bindings = yield* ResourceBindingRepo
      const remaining = yield* bindings.listByContest(CONTEST_ID)
      expect(remaining.filter((b) => b.canonicalKey === "inucon-team1-1")).toEqual([])
    }).pipe(Effect.provide(fixture.layer))
  })

  it.effect("per-hostname handler は CloudflareError で fail するが continueOnError=true で次 hostname に進める", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({
        cloudflareFailWith: {
          removeAccessApp: new CloudflareError({ cause: "test-injected" })
        }
      })
      const registry = yield* makeCleanupHandler.pipe(Effect.provide(fixture.layer))
      const exit = yield* Effect.exit(
        registry
          .run(
            stepOf(cleanupStepKeyFor("inucon-team1-1"), {
              hostname: "inucon-team1-1",
              contestId: CONTEST_ID
            })
          )
          .pipe(Effect.provide(fixture.layer))
      )
      expect(Exit.isFailure(exit)).toBe(true)
      // NewOperation の step は continueOnError=true で積まれるので、worker は
      // このハンドラ失敗を「per-hostname 失敗」として運用継続する。ここでは
      // ハンドラ自身が OperationExecutionError で fail するのみを assert。
    })
  )

  it.effect("mark_completed step: 再観測が clean なら Contest.cleanupCompletedAt を刻む", () => {
    // inventory を「もう何もない」に絞り、binding + instance も空に。
    const fixture = makeFixture({
      proxmoxVms: [],
      cloudflareRoutes: [],
      cloudflareApps: [],
      instances: [],
      bindings: []
    })
    return Effect.gen(function* () {
      const registry = yield* makeCleanupHandler
      const outcome = yield* registry.run(
        stepOf(CLEANUP_MARK_COMPLETED_STEP_KEY, { contestId: CONTEST_ID })
      )
      expect(outcome.status).toBe("succeeded")

      const contests = yield* ContestRepo
      const after = yield* contests.findById(CONTEST_ID)
      if (Option.isSome(after)) {
        expect(Option.isSome(after.value.cleanupCompletedAt)).toBe(true)
      }
    }).pipe(Effect.provide(fixture.layer))
  })

  it.effect("mark_completed step: residual hostname が残れば blocked を返し cleanupCompletedAt は刻まない", () => {
    // hostname は残ったまま (Proxmox に inucon-team1-1 の VM が居る)。
    const fixture = makeFixture()
    return Effect.gen(function* () {
      const registry = yield* makeCleanupHandler
      const outcome = yield* registry.run(
        stepOf(CLEANUP_MARK_COMPLETED_STEP_KEY, { contestId: CONTEST_ID })
      )
      expect(outcome.status).toBe("blocked")
      expect(outcome.summary).toContain("residual_hostnames:")
    }).pipe(Effect.provide(fixture.layer))
  })

  it.effect("scheduleContestCleanup: hostname 対象 0 件なら NothingToReconcile", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({
        proxmoxVms: [],
        cloudflareRoutes: [],
        cloudflareApps: [],
        instances: [],
        bindings: []
      })
      const exit = yield* Effect.exit(
        scheduleContestCleanup({ contestId: CONTEST_ID }).pipe(Effect.provide(fixture.layer))
      )
      expect(Exit.isFailure(exit)).toBe(true)
    })
  )
})

// --- cleanup 対象選択の到達性 (2026-10-01 本番 edition1 の回帰) ---------------
//
// 本番で踏んだデッドロック: finished な Contest に「DB 上は running だが Proxmox に
// 実体が無い Instance」が残ると、Instance を deleted へ落とす経路が UI から消える。
// readiness の previous_cleanup (finished/canceled の全 Contest について
// status != 'deleted' の Instance が 0 件) が永久に fail し、次回開催の Contest が
// draft から preparing に上がれなくなる。
//
// 再現状態 (本番 edition1, 2026-10-01):
//   teams      : team1 (teamNumber=1, desired 1) / team2 (teamNumber=2, desired 0)
//   instances  : 1 行 (index=1, vmid=1101, running) — 実体の VM は無い
//   bindings   : 0 行
//   Proxmox    : inucon-team* VM は 0 件
//   Cloudflare : inucon-team1-1 / inucon-team2-1 に DNS + ingress + Access app
const TEAM2_ID = TeamId.make("team2-cleanup")

const team2 = makeTeam({
  id: TEAM2_ID,
  contestId: CONTEST_ID,
  teamNumber: 2,
  name: "team2-test-name",
  desiredInstanceCount: 0
})

const instance1_1Deleted = new Instance({ ...instance1_1, status: "deleted", updatedAt: 2000 })

// 本番そのまま: VM と binding は消えているが CF resource は両 hostname に残る。
const prodCloudflareRoutes = [
  { hostname: "inucon-team1-1", dnsRecordIds: ["dns-1"], ingressServices: ["ssh://10.100.1.11:22"] },
  { hostname: "inucon-team2-1", dnsRecordIds: ["dns-2"], ingressServices: ["ssh://10.100.2.11:22"] }
] as const

const prodCloudflareApps = [
  { hostname: "inucon-team1-1", appIds: ["app-1"], policyShape: "owned_exact", emailSetHash: "h1" },
  { hostname: "inucon-team2-1", appIds: ["app-2"], policyShape: "owned_exact", emailSetHash: "h2" }
] as const

// reconcile apply (adopt=inucon-team2-1) 完了後: CF resource も binding も消えたが、
// makeReconciliationHandler は InstanceRepo に依存しないので Instance は running で
// 取り残される。この状態が本番で詰んでいた入口。
const afterReconcileFixture = (instances: ReadonlyArray<Instance> = [instance1_1]) =>
  makeFixture({
    teams: [team1, team2],
    proxmoxVms: [],
    bindings: [],
    instances,
    cloudflareRoutes: [],
    cloudflareApps: []
  })

const summarize = (entries: ReadonlyArray<{ hostname: string; classification: string; action: string; reason: string }>) =>
  entries
    .map((e) => ({ hostname: e.hostname, classification: e.classification, action: e.action, reason: e.reason }))
    .sort((x, y) => (x.hostname < y.hostname ? -1 : 1))

describe("cleanup 対象選択の到達性", () => {
  it.effect("前提: 本番状態の plan は team1-1=missing/cleanup と team2-1=unmanaged_orphan/blocked", () => {
    const fixture = makeFixture({
      teams: [team1, team2],
      proxmoxVms: [],
      bindings: [],
      cloudflareRoutes: prodCloudflareRoutes,
      cloudflareApps: prodCloudflareApps
    })
    return Effect.gen(function* () {
      const plan = yield* planReconciliation({ contestId: CONTEST_ID, adoptHostnames: [] })
      expect(summarize(plan.entries)).toEqual([
        { hostname: "inucon-team1-1", classification: "missing", action: "cleanup", reason: "vm_missing" },
        {
          hostname: "inucon-team2-1",
          classification: "unmanaged_orphan",
          action: "blocked",
          reason: "requires_adopt_confirmation"
        }
      ])
    }).pipe(Effect.provide(fixture.layer))
  })

  it.effect("未 adopt の unmanaged_orphan が居る間は AmbiguousReconciliation (adopt 確認 gate)", () => {
    const fixture = makeFixture({
      teams: [team1, team2],
      proxmoxVms: [],
      bindings: [],
      cloudflareRoutes: prodCloudflareRoutes,
      cloudflareApps: prodCloudflareApps
    })
    return Effect.gen(function* () {
      const plan = yield* planReconciliation({ contestId: CONTEST_ID, adoptHostnames: [] })
      const result = yield* Effect.either(
        cleanupContestResources({
          contestId: CONTEST_ID,
          planDigest: plan.planDigest,
          actorUserId: ADMIN_USER
        })
      )
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left._tag).toBe("AmbiguousReconciliation")
      }
    }).pipe(Effect.provide(fixture.layer))
  })

  it.effect("missing/noop/missing_clean_pending_db を cleanup 対象に拾う (admin apply)", () => {
    const fixture = afterReconcileFixture()
    return Effect.gen(function* () {
      const plan = yield* planReconciliation({ contestId: CONTEST_ID, adoptHostnames: [] })
      // team2-1 は desired も観測も無くなったので hostname key 自体が生成されない。
      expect(summarize(plan.entries)).toEqual([
        {
          hostname: "inucon-team1-1",
          classification: "missing",
          action: "noop",
          reason: "missing_clean_pending_db"
        }
      ])
      const op = yield* cleanupContestResources({
        contestId: CONTEST_ID,
        planDigest: plan.planDigest,
        actorUserId: ADMIN_USER
      })
      const steps = yield* (yield* OperationRepo).listSteps(op.id)
      expect(steps.map((s) => s.stepKey)).toEqual([
        cleanupStepKeyFor("inucon-team1-1"),
        CLEANUP_MARK_COMPLETED_STEP_KEY
      ])
    }).pipe(Effect.provide(fixture.layer))
  })

  it.effect("missing/noop/missing_clean_pending_db を cleanup 対象に拾う (scheduler 経路)", () => {
    const fixture = afterReconcileFixture()
    return Effect.gen(function* () {
      const op = yield* scheduleContestCleanup({ contestId: CONTEST_ID })
      expect(op.actor).toEqual({ kind: "scheduler" })
      const steps = yield* (yield* OperationRepo).listSteps(op.id)
      expect(steps.map((s) => s.stepKey)).toEqual([
        cleanupStepKeyFor("inucon-team1-1"),
        CLEANUP_MARK_COMPLETED_STEP_KEY
      ])
    }).pipe(Effect.provide(fixture.layer))
  })

  it.effect("Instance が deleted なら拾わない (空 Operation の無限生成を防ぐ)", () => {
    const fixture = afterReconcileFixture([instance1_1Deleted])
    return Effect.gen(function* () {
      const plan = yield* planReconciliation({ contestId: CONTEST_ID, adoptHostnames: [] })
      expect(summarize(plan.entries)).toEqual([
        {
          hostname: "inucon-team1-1",
          classification: "in_sync",
          action: "noop",
          reason: "managed_orphan_clean"
        }
      ])
      const applyResult = yield* Effect.either(
        cleanupContestResources({
          contestId: CONTEST_ID,
          planDigest: plan.planDigest,
          actorUserId: ADMIN_USER
        })
      )
      expect(applyResult._tag).toBe("Left")
      if (applyResult._tag === "Left") {
        expect(applyResult.left._tag).toBe("NothingToReconcile")
      }
      const schedulerResult = yield* Effect.either(scheduleContestCleanup({ contestId: CONTEST_ID }))
      expect(schedulerResult._tag).toBe("Left")
      if (schedulerResult._tag === "Left") {
        expect(schedulerResult.left._tag).toBe("NothingToReconcile")
      }
    }).pipe(Effect.provide(fixture.layer))
  })

  it.effect("収束: cleanup → Instance deleted → mark_completed → 次 cleanup は NothingToReconcile", () => {
    const fixture = afterReconcileFixture()
    return Effect.gen(function* () {
      const plan = yield* planReconciliation({ contestId: CONTEST_ID, adoptHostnames: [] })
      yield* cleanupContestResources({
        contestId: CONTEST_ID,
        planDigest: plan.planDigest,
        actorUserId: ADMIN_USER
      })

      // VM も CF resource も binding も無い hostname でも handler は冪等に成功し、
      // Instance を deleted まで落とす。
      const registry = yield* makeCleanupHandler
      const hostnameOutcome = yield* registry.run(
        stepOf(cleanupStepKeyFor("inucon-team1-1"), {
          hostname: "inucon-team1-1",
          contestId: CONTEST_ID
        })
      )
      expect(hostnameOutcome.status).toBe("succeeded")
      const instances = yield* InstanceRepo
      const afterCleanup = yield* instances.listByContest(CONTEST_ID)
      expect(afterCleanup.find((i) => i.id === INSTANCE_1_1)?.status).toBe("deleted")
      // 実体が無いので destroy は 1 度も呼ばれない (fail-closed を崩さずに冪等)。
      const proxmoxState = yield* fixture.proxmox.getState
      expect(proxmoxState.destroyedVmids).toEqual([])

      const markOutcome = yield* registry.run(stepOf(CLEANUP_MARK_COMPLETED_STEP_KEY, { contestId: CONTEST_ID }))
      expect(markOutcome.status).toBe("succeeded")
      const contests = yield* ContestRepo
      const contestAfter = yield* contests.findById(CONTEST_ID)
      expect(Option.isSome(contestAfter) && Option.isSome(contestAfter.value.cleanupCompletedAt)).toBe(true)

      // 収束後の次 plan は clean。ここをもう一度拾うと空 Operation を無限に作る。
      const nextPlan = yield* planReconciliation({ contestId: CONTEST_ID, adoptHostnames: [] })
      expect(summarize(nextPlan.entries)).toEqual([
        {
          hostname: "inucon-team1-1",
          classification: "in_sync",
          action: "noop",
          reason: "managed_orphan_clean"
        }
      ])
      const again = yield* Effect.either(
        cleanupContestResources({
          contestId: CONTEST_ID,
          planDigest: nextPlan.planDigest,
          actorUserId: ADMIN_USER
        })
      )
      expect(again._tag).toBe("Left")
      if (again._tag === "Left") {
        expect(again.left._tag).toBe("NothingToReconcile")
      }
    }).pipe(Effect.provide(fixture.layer))
  })
})

// --- returnNormalMode -------------------------------------------------------

describe("returnNormalMode", () => {
  it("スペックに定義された 8 step key を持つ", () => {
    expect([...RETURN_NORMAL_MODE_STEP_KEYS]).toEqual([
      "verify_no_managed_vms",
      "set_benchvm_onboot_0",
      "shutdown_benchvm",
      "wait_benchvm_stopped",
      "memory_check",
      "set_devvm_onboot_1",
      "start_devvm",
      "verify_devvm_running"
    ])
  })

  it.effect("managed VM が残っている状態で呼ぶと ResidualManagedResource で fail する", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        returnNormalMode({ contestId: CONTEST_ID, actorUserId: ADMIN_USER })
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const cause = exit.cause
        // Cause 内の failure を拾う軽い check (typed error)
        const found = JSON.stringify(cause).includes("ResidualManagedResource")
        expect(found).toBe(true)
      }
    }).pipe(Effect.provide(makeFixture().layer))
  )

  // review round 3 #2: running / preparing / draft のうちに return_normal_mode を
  // 呼ぶと参加者経路 (benchvm 経由 CF tunnel) を切り落とすので拒否する。
  it.effect("finished / canceled 以外の Contest では InvalidContestTransition で拒否する", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        returnNormalMode({ contestId: CONTEST_ID, actorUserId: ADMIN_USER })
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("InvalidContestTransition")
      }
    }).pipe(
      Effect.provide(
        makeFixture({
          proxmoxVms: [],
          contests: [
            makeContest({
              id: CONTEST_ID,
              edition: 1,
              status: "running",
              startedAt: Option.some(100),
              scheduledStartAt: Option.some(100),
              scheduledEndAt: Option.some(2000),
              accessClosesAt: Option.some(2000),
              revision: 1
            })
          ]
        }).layer
      )
    )
  )

  it.effect("managed VM が 0 件で listManagedVms が空なら 8-step の Operation を enqueue する", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({
        proxmoxVms: []
      })
      const op = yield* returnNormalMode({
        contestId: CONTEST_ID,
        actorUserId: ADMIN_USER
      }).pipe(Effect.provide(fixture.layer))
      expect(op.kind).toBe("return_normal_mode")
      const ops = yield* OperationRepo.pipe(Effect.provide(fixture.layer))
      const steps = yield* ops.listSteps(op.id).pipe(Effect.provide(fixture.layer))
      expect(steps.map((s) => s.stepKey)).toEqual([...RETURN_NORMAL_MODE_STEP_KEYS])
    })
  )

  it.effect("handler: benchvm shutdown は verify_no_managed_vms の後にのみ実行できる", () =>
    Effect.gen(function* () {
      // managed VM がまだ残っている状態で verify_no_managed_vms 単体を叩き、
      // blocked を返すことを確認する (benchvm shutdown は絶対に呼ばない gate)。
      const fixture = makeFixture()
      const registry = yield* makeReturnNormalModeHandler.pipe(Effect.provide(fixture.layer))
      const outcome = yield* registry
        .run(stepOf("verify_no_managed_vms", { contestId: CONTEST_ID }))
        .pipe(Effect.provide(fixture.layer))
      expect(outcome.status).toBe("blocked")
      expect(outcome.summary).toContain("residual_managed_vms")
    })
  )

  it.effect("handler: memory_check は post-shutdown MemAvailable + benchvm RAM が devvm 要求 + reserve を満たさなければ blocked", () =>
    Effect.gen(function* () {
      // benchvm.memoryBytes=4Gi、devvm.memoryBytes=8Gi、free=2Gi → projected 6Gi、
      // required = 8Gi + 1Gi = 9Gi。projected < required → blocked。
      const fixture = makeFixture({
        proxmoxVms: []
      })
      // proxmox port の infrastructureInventory を上書き
      const proxmox = makeProxmoxPortTest({
        managedVms: [],
        infrastructureInventory: {
          nodeFreeMemBytes: 2 * 1024 * 1024 * 1024,
          templateExists: true,
          devvm: {
            vmid: 9300,
            name: "devvm",
            status: "stopped",
            memoryBytes: 8 * 1024 * 1024 * 1024,
            onBoot: false
          },
          benchvm: {
            vmid: 9200,
            name: "benchvm",
            status: "running",
            memoryBytes: 4 * 1024 * 1024 * 1024,
            onBoot: true
          },
          preparedTeamNumbers: [1, 2],
          isolationServiceActive: false
        }
      })
      const layer = Layer.mergeAll(proxmox.layer)
      const registry = yield* makeReturnNormalModeHandler.pipe(Effect.provide(layer))
      const outcome = yield* registry
        .run(stepOf("memory_check", { contestId: CONTEST_ID }))
        .pipe(Effect.provide(layer))
      expect(outcome.status).toBe("blocked")
    })
  )

  it.effect("handler: 全ての step が healthy な post-mode inventory では succeeded を返す", () =>
    Effect.gen(function* () {
      // benchvm stopped, devvm running, ample free memory。
      const proxmox = makeProxmoxPortTest({
        managedVms: [],
        infrastructureInventory: {
          nodeFreeMemBytes: 20 * 1024 * 1024 * 1024,
          templateExists: true,
          devvm: {
            vmid: 9300,
            name: "devvm",
            status: "running",
            memoryBytes: 8 * 1024 * 1024 * 1024,
            onBoot: true
          },
          benchvm: {
            vmid: 9200,
            name: "benchvm",
            status: "stopped",
            memoryBytes: 4 * 1024 * 1024 * 1024,
            onBoot: false
          },
          preparedTeamNumbers: [1, 2],
          isolationServiceActive: false
        }
      })
      const layer = Layer.mergeAll(proxmox.layer)
      const registry = yield* makeReturnNormalModeHandler.pipe(Effect.provide(layer))
      for (const key of RETURN_NORMAL_MODE_STEP_KEYS) {
        const outcome = yield* registry
          .run(stepOf(key, { contestId: CONTEST_ID }))
          .pipe(Effect.provide(layer))
        expect(outcome.status).toBe("succeeded")
      }
    })
  )

  // production を壊した実バグ (定数側 9200/9300 が実機と逆) の再発防止。
  // return_normal_mode は benchvm を止めて devvm を起動するので、mapping が
  // ズレていると「開発サーバを止めて bench runner を起動」する。observed name が
  // 期待値と一致しない限り power 操作を一切発行せず blocked に落とす。
  it.effect("handler: mode VM の observed name が期待値と違えば blocked、power 操作は発行しない", () =>
    Effect.gen(function* () {
      const proxmox = makeProxmoxPortTest({
        managedVms: [],
        infrastructureInventory: {
          nodeFreeMemBytes: 20 * 1024 * 1024 * 1024,
          templateExists: true,
          devvm: {
            vmid: 9300,
            name: "benchvm",
            status: "stopped",
            memoryBytes: 8 * 1024 * 1024 * 1024,
            onBoot: false
          },
          benchvm: {
            vmid: 9200,
            name: "devvm",
            status: "running",
            memoryBytes: 4 * 1024 * 1024 * 1024,
            onBoot: true
          },
          preparedTeamNumbers: [1, 2],
          isolationServiceActive: false
        }
      })
      const layer = Layer.mergeAll(proxmox.layer)
      const registry = yield* makeReturnNormalModeHandler.pipe(Effect.provide(layer))
      // verify_no_managed_vms は power 操作を発行しないので inventory 検証の対象外。
      const powerStepKeys = RETURN_NORMAL_MODE_STEP_KEYS.filter((k) => k !== "verify_no_managed_vms")
      for (const key of powerStepKeys) {
        const outcome = yield* registry
          .run(stepOf(key, { contestId: CONTEST_ID }))
          .pipe(Effect.provide(layer))
        expect(outcome.status).toBe("blocked")
        expect(outcome.summary).toBe(
          "VMID mapping mismatch: VM 9300 is named 'benchvm', expected 'devvm'; " +
            "verify /vms mapping before any power operation"
        )
      }
      const state = yield* proxmox.getState
      expect(state.shutdownRequests).toEqual([])
      expect(state.startedVmids).toEqual([])
      expect(state.onBootByVmid).toEqual({})
      expect(state.forceStopRequests).toEqual([])
    })
  )
})
