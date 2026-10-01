import { HttpBody, HttpClient } from "@effect/platform"
import { it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { Operation, ReconciliationPlan } from "shared/schemas"
import { describe, expect } from "vitest"
import { CloudflareError, ContestRepo, InstanceRepo, OperationRepo, ProxmoxError, ResourceBindingRepo, TeamRepo } from "../../src/application/ports.js"
import { ENTER_CONTEST_MODE_STEP_KEYS } from "../../src/application/usecases/modeOperation.js"
import { PREPARE_STEP_KEY } from "../../src/application/usecases/prepare.js"
import type { ContestStatus } from "../../src/domain/contest.js"
import { ContestId, InstanceId, OperationId, ResourceBindingId, TeamId } from "../../src/domain/ids.js"
import { Instance } from "../../src/domain/instance.js"
import { BENCHVM_VM_NAME, BENCHVM_VMID, DEVVM_VM_NAME, DEVVM_VMID } from "../../src/domain/modeVmIds.js"
import { sanitizeOperationError } from "../../src/domain/operation.js"
import type { OperationStatus } from "../../src/domain/operation.js"
import { ResourceBinding } from "../../src/domain/resourceBinding.js"
import type { InfrastructureInventorySeed } from "../support/inMemory.js"
import { login } from "../support/login.js"
import { asAdmin } from "../support/apiTestHelpers.js"
import { makeAppTestLayer } from "../support/testApi.js"
import { makeContest, makeTeam } from "../support/factories.js"

// Task 7 Step 6: /api/admin/contests/:id/reconciliation/{plan,apply} + operations
// detail/retry の HTTP 境界を検証する。AdminOnly / 主要 status(200/403/404/
// 409/422)のみを集中して確認する。深い挙動は test/application/reconciliation.test.ts。

const postJson = (cookieHeader: string, path: string, payload: unknown) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const body = yield* HttpBody.json(payload).pipe(Effect.orDie)
    return yield* client.post(path, { headers: { cookie: cookieHeader }, body })
  })

const CONTEST_ID = ContestId.make("c-edition1")
const TEAM1_ID = TeamId.make("team1-id")
const INSTANCE_1_1 = InstanceId.make("i-1-1")
const BINDING_DNS = ResourceBindingId.make("b-dns-1-1")

const seedLegacy = Effect.gen(function* () {
  const contests = yield* ContestRepo
  yield* contests.create(
    makeContest({
      id: CONTEST_ID,
      edition: 1,
      status: "finished",
      revision: 1,
      problemRevision: "legacy-2026-07-08"
    })
  )
  const teams = yield* TeamRepo
  yield* teams.create(
    makeTeam({
      id: TEAM1_ID,
      contestId: CONTEST_ID,
      teamNumber: 1,
      name: "team1",
      desiredInstanceCount: 1
    })
  )
  const instances = yield* InstanceRepo
  yield* instances.create(
    new Instance({
      id: INSTANCE_1_1,
      contestId: CONTEST_ID,
      teamId: TEAM1_ID,
      index: 1,
      vmid: 1101,
      privateIp: "10.100.1.11",
      status: "running",
      progress: [],
      errorMessage: Option.none(),
      createdAt: 1000,
      updatedAt: 1000
    })
  )
  const bindings = yield* ResourceBindingRepo
  yield* bindings.upsert(
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
    })
  )
})

// CF inventory を seed した TestLayer(unmanaged_orphan の分岐検証用)。
// team2-1 は binding も Instance も無い状態で CF だけに存在する = 2026-08-13
// fixture の再現。
const OperationsTestLayer = makeAppTestLayer({
  adminGithubLogins: ["admin-login"],
  cloudflareInventory: {
    routes: [
      { hostname: "inucon-team1-1", dnsRecordIds: ["dns-1"], ingressServices: ["ssh://10.100.1.11:22"] },
      { hostname: "inucon-team2-1", dnsRecordIds: ["dns-2"], ingressServices: ["ssh://10.100.2.11:22"] }
    ],
    apps: [
      { hostname: "inucon-team1-1", appIds: ["app-1"], policyShape: "owned_exact", emailSetHash: "h1" },
      { hostname: "inucon-team2-1", appIds: ["app-2"], policyShape: "unknown", emailSetHash: "h2" }
    ]
  }
})

describe("POST /api/admin/contests/:contestId/reconciliation/plan", () => {
  it.effect("非 admin は403", () =>
    Effect.gen(function* () {
      const { cookieHeader: cookie } = yield* login({
        githubLogin: "user1",
        githubId: 1,
        isAdmin: false
      })
      const res = yield* postJson(
        cookie,
        `/api/admin/contests/${CONTEST_ID}/reconciliation/plan`,
        { adoptHostnames: [] }
      )
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  it.effect("admin は200で plan を返す(email 生値を絶対に含まない)", () =>
    Effect.gen(function* () {
      yield* seedLegacy
      const { cookieHeader: cookie } = yield* asAdmin()
      const res = yield* postJson(
        cookie,
        `/api/admin/contests/${CONTEST_ID}/reconciliation/plan`,
        { adoptHostnames: [] }
      )
      expect(res.status).toBe(200)
      const text = yield* res.text
      // 生 email を絶対に混ぜない(handler / port どちらの層でも)
      expect(text).not.toMatch(/@/)
      const body = JSON.parse(text) as { planDigest: string; entries: ReadonlyArray<unknown> }
      expect(body.planDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(Array.isArray(body.entries)).toBe(true)
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  it.effect("存在しない contest は404", () =>
    Effect.gen(function* () {
      const { cookieHeader: cookie } = yield* asAdmin()
      const res = yield* postJson(
        cookie,
        `/api/admin/contests/${ContestId.make("nope")}/reconciliation/plan`,
        { adoptHostnames: [] }
      )
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(OperationsTestLayer))
  )
})

// review round 3 #1: 上流 provider(CF)inventory 取得失敗を 503 で明示する。
// 従来は Effect.orDie で 500 defect(unknown provider issue)に落ちていた。
describe("planReconciliation with provider outage", () => {
  it.effect("Cloudflare getInstanceInventory が失敗すると 503 ProviderUnavailable", () =>
    Effect.gen(function* () {
      yield* seedLegacy
      const { cookieHeader: cookie } = yield* asAdmin()
      const res = yield* postJson(
        cookie,
        `/api/admin/contests/${CONTEST_ID}/reconciliation/plan`,
        { adoptHostnames: [] }
      )
      expect(res.status).toBe(503)
      const body = JSON.parse(yield* res.text) as { _tag: string; provider: string }
      expect(body._tag).toBe("ProviderUnavailable")
      expect(body.provider).toBe("cloudflare")
    }).pipe(
      Effect.provide(
        makeAppTestLayer({
          adminGithubLogins: ["admin-login"],
          cloudflareFailWith: {
            getInstanceInventory: new (
              // 直接構築するために class を参照(Data.TaggedError なので new で OK)
              CloudflareError
            )({ cause: "simulated outage" })
          }
        })
      )
    )
  )
})

describe("POST /api/admin/contests/:contestId/reconciliation/apply", () => {
  it.effect("stale digest は409", () =>
    Effect.gen(function* () {
      yield* seedLegacy
      const { cookieHeader: cookie } = yield* asAdmin()
      const res = yield* postJson(
        cookie,
        `/api/admin/contests/${CONTEST_ID}/reconciliation/apply`,
        {
          planDigest: "0".repeat(64),
          adoptHostnames: ["inucon-team2-1"]
        }
      )
      expect(res.status).toBe(409)
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  it.effect("ambiguous(adopt 未指定で unmanaged_orphan あり)は422", () =>
    Effect.gen(function* () {
      yield* seedLegacy
      const { cookieHeader: cookie } = yield* asAdmin()
      const planRes = yield* postJson(
        cookie,
        `/api/admin/contests/${CONTEST_ID}/reconciliation/plan`,
        { adoptHostnames: [] }
      )
      const plan = JSON.parse(yield* planRes.text) as {
        planDigest: string
      }
      const res = yield* postJson(
        cookie,
        `/api/admin/contests/${CONTEST_ID}/reconciliation/apply`,
        {
          planDigest: plan.planDigest,
          adoptHostnames: []
        }
      )
      expect(res.status).toBe(422)
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  // Task 7 review #1: 別 admin が同時に別 reconcile Operation を進行中の
  // ときは 500 ではなく 409 (OperationalContestConflict) に落とす。
  // 事前に別の未完了 Operation を用意して、apply が enqueue 段で拒否される
  // ことを確認する。
  it.effect("既に別 Operation が queued/running なら 409 (OperationalContestConflict)", () =>
    Effect.gen(function* () {
      yield* seedLegacy
      // 別の未完了 Operation を先に enqueue しておく(kind は問わない)。
      const ops = yield* OperationRepo
      yield* ops.enqueue({
        contestId: CONTEST_ID,
        kind: "reconcile",
        actor: { kind: "scheduler" },
        planDigest: "existing-digest",
        contestRevision: 1,
        steps: [{ stepKey: "reconcile:inucon-team1-1", ordinal: 0, inputSummary: "{}", continueOnError: false }]
      })
      const { cookieHeader: cookie } = yield* asAdmin()
      // plan → apply(adopt=team2-1)。stale ではないが enqueue で
      // OperationInProgress → 409 に落ちるはず。
      const planRes = yield* postJson(
        cookie,
        `/api/admin/contests/${CONTEST_ID}/reconciliation/plan`,
        { adoptHostnames: ["inucon-team2-1"] }
      )
      const plan = JSON.parse(yield* planRes.text) as { planDigest: string; contestRevision: number }
      const res = yield* postJson(
        cookie,
        `/api/admin/contests/${CONTEST_ID}/reconciliation/apply`,
        {
          planDigest: plan.planDigest,
          adoptHostnames: ["inucon-team2-1"]
        }
      )
      expect(res.status).toBe(409)
      const body = JSON.parse(yield* res.text) as { _tag: string }
      expect(body._tag).toBe("OperationalContestConflict")
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  // review round 8 #3: NothingToReconcile → 409 の HTTP マッピングを
  // 実際に発火させる。in-sync fixture(VM 有り + CF full)で seedLegacy と
  // 同じ team1-1 を DB desired にすれば actionable=0 になり、NothingToReconcile
  // を返す。以前のテストは blocked が残る fixture で apply を呼んでいなかった
  // ので、409 → body._tag の mapping を実質検証できていなかった。
  it.effect("in_sync only なら apply が 409 (NothingToReconcile) を返す", () =>
    Effect.gen(function* () {
      // NothingToReconcile を発火させるには actionable な entry が 0 個の
      // 状態が必要。seedLegacy は CF binding を張るので、ここでは binding
      // 無しの minimal seed を作る(Instance も無いので team1-1 hostname が
      // 出現せず、entries は空 → actionable 0 → NothingToReconcile)。
      const contests = yield* ContestRepo
      yield* contests.create(
        makeContest({
          id: CONTEST_ID,
          edition: 1,
          status: "finished",
          revision: 1,
          problemRevision: "legacy-2026-07-08"
        })
      )
      const { cookieHeader: cookie } = yield* asAdmin()
      const planRes = yield* postJson(
        cookie,
        `/api/admin/contests/${CONTEST_ID}/reconciliation/plan`,
        { adoptHostnames: [] }
      )
      expect(planRes.status).toBe(200)
      const plan = JSON.parse(yield* planRes.text) as { planDigest: string }
      const applyRes = yield* postJson(
        cookie,
        `/api/admin/contests/${CONTEST_ID}/reconciliation/apply`,
        {
          planDigest: plan.planDigest,
          adoptHostnames: []
        }
      )
      // entries=[] (何も観測されず、DB desired も無い) → actionable=0 →
      // NothingToReconcile → 409。
      expect(applyRes.status).toBe(409)
      const body = JSON.parse(yield* applyRes.text) as { _tag: string }
      expect(body._tag).toBe("NothingToReconcile")
    }).pipe(
      Effect.provide(
        makeAppTestLayer({
          adminGithubLogins: ["admin-login"],
          // provider inventory を空にする → 全 hostname が現れず entries=[]。
          cloudflareInventory: { routes: [], apps: [] },
          proxmoxManagedVms: []
        })
      )
    )
  )
})

// Task 8: GET /api/admin/contests/:contestId/readiness (AdminOnly)。
// readiness は mutation を一切行わず、非機密の check 一覧を返す。
describe("GET /api/admin/contests/:contestId/readiness", () => {
  it.effect("非 admin は 403", () =>
    Effect.gen(function* () {
      yield* seedLegacy
      const { cookieHeader: cookie } = yield* login({
        githubLogin: "user1",
        githubId: 1,
        isAdmin: false
      })
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get(`/api/admin/contests/${CONTEST_ID}/readiness`, {
        headers: { cookie }
      })
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  it.effect("admin は 200 で checks 配列を返す(生 email / bearer / cause を絶対に含まない)", () =>
    Effect.gen(function* () {
      yield* seedLegacy
      const { cookieHeader: cookie } = yield* asAdmin()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get(`/api/admin/contests/${CONTEST_ID}/readiness`, {
        headers: { cookie }
      })
      expect(res.status).toBe(200)
      const text = yield* res.text
      expect(text).not.toMatch(/@/) // no raw emails
      expect(text).not.toMatch(/Bearer/i) // no bearer tokens
      const body = JSON.parse(text) as ReadonlyArray<{ key: string; status: string; summary: string }>
      expect(Array.isArray(body)).toBe(true)
      // 少なくとも previous_cleanup と cloudflare_token key は必ず含まれる。
      const keys = body.map((c) => c.key)
      expect(keys.includes("previous_cleanup")).toBe(true)
      expect(keys.includes("cloudflare_token")).toBe(true)
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  it.effect("存在しない contest は 404", () =>
    Effect.gen(function* () {
      const { cookieHeader: cookie } = yield* asAdmin()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get(`/api/admin/contests/${ContestId.make("nope")}/readiness`, {
        headers: { cookie }
      })
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(OperationsTestLayer))
  )
})

// Task 10: POST /api/admin/contests/:contestId/start は AdminOnly、Operation を
// 返す 202 相当のエンドポイント。fresh readiness の再検査は worker が動かす
// step handler の責務なので、ここでは「enqueue まで」の 200/4xx を検証する。
describe("POST /api/admin/contests/:contestId/start (Task 10)", () => {
  const startSetup = () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      const contest = makeContest({
        id: ContestId.make("c-start-1"),
        edition: 2,
        status: "preparing",
        revision: 1
      })
      yield* contests.create(contest)
      return contest
    })

  it.effect("非 admin は 403", () =>
    Effect.gen(function* () {
      const contest = yield* startSetup()
      const { cookieHeader } = yield* login({ githubLogin: "u-start-nonadmin", githubId: 7100 })
      const res = yield* postJson(cookieHeader, `/api/admin/contests/${contest.id}/start`, {
        expectedRevision: contest.revision
      })
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  it.effect("admin + preparing + revision 一致 → 200 で Operation を返す (kind='start')", () =>
    Effect.gen(function* () {
      const contest = yield* startSetup()
      const { cookieHeader: cookie } = yield* asAdmin()
      const res = yield* postJson(cookie, `/api/admin/contests/${contest.id}/start`, {
        expectedRevision: contest.revision
      })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { kind: string; status: string; contestId: string }
      expect(body.kind).toBe("start")
      expect(body.status).toBe("queued")
      expect(body.contestId).toBe(contest.id)
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  it.effect("revision drift は 409 ContestRevisionConflict", () =>
    Effect.gen(function* () {
      const contest = yield* startSetup()
      const { cookieHeader: cookie } = yield* asAdmin()
      const res = yield* postJson(cookie, `/api/admin/contests/${contest.id}/start`, {
        expectedRevision: contest.revision + 42
      })
      expect(res.status).toBe(409)
      const body = (yield* res.json) as { _tag: string; expected: number; actual: number }
      expect(body._tag).toBe("ContestRevisionConflict")
      expect(body.expected).toBe(contest.revision + 42)
      expect(body.actual).toBe(contest.revision)
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  it.effect("preparing でない Contest は 409 InvalidContestTransition", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      const draft = makeContest({
        id: ContestId.make("c-start-draft"),
        edition: 3,
        status: "draft",
        revision: 1
      })
      yield* contests.create(draft)
      const { cookieHeader: cookie } = yield* asAdmin()
      const res = yield* postJson(cookie, `/api/admin/contests/${draft.id}/start`, {
        expectedRevision: 1
      })
      expect(res.status).toBe(409)
      const body = (yield* res.json) as { _tag: string }
      expect(body._tag).toBe("InvalidContestTransition")
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  it.effect("存在しない contest は 404", () =>
    Effect.gen(function* () {
      const { cookieHeader: cookie } = yield* asAdmin()
      const res = yield* postJson(
        cookie,
        `/api/admin/contests/${ContestId.make("no-such-contest")}/start`,
        { expectedRevision: 1 }
      )
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(OperationsTestLayer))
  )
})

// Task 12: POST /api/admin/contests/:contestId/cleanup (AdminOnly)
// planDigest 一致検証 + per-hostname cleanup steps を積む Operation を返す。
describe("POST /api/admin/contests/:contestId/cleanup (Task 12)", () => {
  it.effect("非 admin は 403", () =>
    Effect.gen(function* () {
      yield* seedLegacy
      const { cookieHeader } = yield* login({ githubLogin: "u-cleanup-nonadmin", githubId: 8100 })
      const res = yield* postJson(cookieHeader, `/api/admin/contests/${CONTEST_ID}/cleanup`, {
        planDigest: "0".repeat(64)
      })
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  it.effect("stale digest は 409 StaleReconciliationPlan", () =>
    Effect.gen(function* () {
      yield* seedLegacy
      const { cookieHeader: cookie } = yield* asAdmin()
      const res = yield* postJson(cookie, `/api/admin/contests/${CONTEST_ID}/cleanup`, {
        planDigest: "0".repeat(64)
      })
      expect(res.status).toBe(409)
      const body = JSON.parse(yield* res.text) as { _tag: string }
      expect(body._tag).toBe("StaleReconciliationPlan")
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  it.effect("plan 一致 + hostname 対象があれば 200 で cleanup Operation を返す", () =>
    Effect.gen(function* () {
      yield* seedLegacy
      const { cookieHeader: cookie } = yield* asAdmin()
      // cleanup は adoptHostnames を持たない = サーバー側は adopt=[] で
      // planDigest を再計算する。UI は必ず adopt=[] の plan を先に取得する。
      const planRes = yield* postJson(
        cookie,
        `/api/admin/contests/${CONTEST_ID}/reconciliation/plan`,
        { adoptHostnames: [] }
      )
      const plan = JSON.parse(yield* planRes.text) as { planDigest: string }
      const res = yield* postJson(cookie, `/api/admin/contests/${CONTEST_ID}/cleanup`, {
        planDigest: plan.planDigest
      })
      // Fixture: team1-1 の VM + CF resource + Instance 有り、team2-1 は adopt
      // 対象で adopt=[] の plan では blocked。cleanup は plan の
      // adoptHostnames=[] を強制するため apply も同じく blocked が残る =
      // AmbiguousReconciliation (422)。ここでは 422 を assert する。
      expect(res.status).toBe(422)
      const body = JSON.parse(yield* res.text) as { _tag: string; hostnames: ReadonlyArray<string> }
      expect(body._tag).toBe("AmbiguousReconciliation")
      expect(body.hostnames).toContain("inucon-team2-1")
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  // Admin Web は cleanup の確認画面に「影響を受ける hostname / VMID」を出すが、
  // 対象選択の述語 (needsCleanupOperation) を web 側に複製しない — 述語が 2 箇所に
  // あったのが PR #77 のデッドロックの原因。plan response の cleanupTarget が
  // cleanup Operation の実際の step 対象と一致することをここで固定する。
  // action=noop でも cleanup の仕事が残る entry (VM 残存 / Instance 遷移待ち) を
  // 含めて、action ベースの選択では一致しないことも同時に確かめる。
  it.effect("plan の cleanupTarget / proxmoxVmid は cleanup Operation が step を作る hostname / 撤収する VM と一致する", () =>
    Effect.gen(function* () {
      yield* seedLegacy
      const instances = yield* InstanceRepo
      // team1-2: Instance deleted + 実体なし → clean (cleanup 対象外)
      // team1-3: 実体は全部消えたが Instance が running → Instance 遷移だけ残る
      for (const [index, status] of [[2, "deleted"], [3, "running"]] as const) {
        yield* instances.create(
          new Instance({
            id: InstanceId.make(`i-1-${index}`),
            contestId: CONTEST_ID,
            teamId: TEAM1_ID,
            index,
            vmid: 1100 + index,
            privateIp: `10.100.1.${10 + index}`,
            status,
            progress: [],
            errorMessage: Option.none(),
            createdAt: 1000,
            updatedAt: 1000
          })
        )
      }
      const { cookieHeader: cookie } = yield* asAdmin()
      const planRes = yield* postJson(
        cookie,
        `/api/admin/contests/${CONTEST_ID}/reconciliation/plan`,
        { adoptHostnames: [] }
      )
      expect(planRes.status).toBe(200)
      const plan = Schema.decodeUnknownSync(ReconciliationPlan)(JSON.parse(yield* planRes.text))
      expect(plan.entries.map((e) => [e.hostname, e.action, e.cleanupTarget, e.proxmoxVmid]).sort()).toEqual([
        ["inucon-team1-1", "noop", true, 1101],
        ["inucon-team1-2", "noop", false, null],
        ["inucon-team1-3", "noop", true, null]
      ])

      const res = yield* postJson(cookie, `/api/admin/contests/${CONTEST_ID}/cleanup`, {
        planDigest: plan.planDigest
      })
      expect(res.status).toBe(200)
      const op = Schema.decodeUnknownSync(Operation)(JSON.parse(yield* res.text))
      expect(op.kind).toBe("cleanup")
      const steps = yield* (yield* OperationRepo).listSteps(OperationId.make(op.id))
      const stepHostnames = steps
        .map((s): unknown => JSON.parse(s.inputSummary))
        .flatMap((summary) =>
          typeof summary === "object" && summary !== null && "hostname" in summary &&
            typeof summary.hostname === "string"
            ? [summary.hostname]
            : []
        )
        .sort()
      expect(stepHostnames).toEqual(
        plan.entries.filter((e) => e.cleanupTarget).map((e) => e.hostname).sort()
      )
    }).pipe(
      Effect.provide(
        makeAppTestLayer({
          adminGithubLogins: ["admin-login"],
          cloudflareInventory: {
            routes: [
              { hostname: "inucon-team1-1", dnsRecordIds: ["dns-1"], ingressServices: ["ssh://10.100.1.11:22"] }
            ],
            apps: [{ hostname: "inucon-team1-1", appIds: ["app-1"], policyShape: "owned_exact", emailSetHash: "h1" }]
          },
          proxmoxManagedVms: [
            { vmid: 1101, name: "inucon-team1-1", status: "running", memoryBytes: 4 * 1024 * 1024 * 1024 }
          ]
        })
      )
    )
  )
})

// Task 12: POST /api/admin/contests/:contestId/return-normal-mode (AdminOnly)
// managed VM が残っていれば 409 ResidualManagedResource。空なら Operation を返す。
describe("POST /api/admin/contests/:contestId/return-normal-mode (Task 12)", () => {
  it.effect("非 admin は 403", () =>
    Effect.gen(function* () {
      yield* seedLegacy
      const { cookieHeader } = yield* login({ githubLogin: "u-rnm-nonadmin", githubId: 8200 })
      const res = yield* postJson(cookieHeader, `/api/admin/contests/${CONTEST_ID}/return-normal-mode`, {})
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  it.effect("managed VM が Proxmox に残っていれば 409 ResidualManagedResource", () =>
    Effect.gen(function* () {
      yield* seedLegacy
      const { cookieHeader: cookie } = yield* asAdmin()
      const res = yield* postJson(
        cookie,
        `/api/admin/contests/${CONTEST_ID}/return-normal-mode`,
        {}
      )
      expect(res.status).toBe(409)
      const body = JSON.parse(yield* res.text) as { _tag: string; hostnames: ReadonlyArray<string> }
      expect(body._tag).toBe("ResidualManagedResource")
    }).pipe(
      Effect.provide(
        makeAppTestLayer({
          adminGithubLogins: ["admin-login"],
          cloudflareInventory: { routes: [], apps: [] },
          proxmoxManagedVms: [
            { vmid: 1101, name: "inucon-team1-1", status: "running", memoryBytes: 4 * 1024 * 1024 * 1024 }
          ]
        })
      )
    )
  )

  it.effect("managed VM 0 件なら 200 で return_normal_mode Operation を返す", () =>
    Effect.gen(function* () {
      yield* seedLegacy
      const { cookieHeader: cookie } = yield* asAdmin()
      const res = yield* postJson(
        cookie,
        `/api/admin/contests/${CONTEST_ID}/return-normal-mode`,
        {}
      )
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { kind: string; status: string }
      expect(body.kind).toBe("return_normal_mode")
      expect(body.status).toBe("queued")
    }).pipe(
      Effect.provide(
        makeAppTestLayer({
          adminGithubLogins: ["admin-login"],
          cloudflareInventory: { routes: [], apps: [] },
          proxmoxManagedVms: []
        })
      )
    )
  )
})

// 競技モード切替 / インスタンス準備の起動経路 (Admin Web → HTTP → Operation)。
// handler / step は Task 8 / 9 で実装済みだが enqueue する経路が無かった。
const GiB = 1024 * 1024 * 1024
// enter_contest_mode が収束した後 = devvm stopped / benchvm running。
const CONTEST_MODE_INVENTORY: InfrastructureInventorySeed = {
  devvm: { vmid: DEVVM_VMID, name: DEVVM_VM_NAME, status: "stopped", memoryBytes: 12 * GiB, onBoot: false },
  benchvm: { vmid: BENCHVM_VMID, name: BENCHVM_VM_NAME, status: "running", memoryBytes: 4 * GiB, onBoot: true }
}
const ContestModeTestLayer = makeAppTestLayer({
  adminGithubLogins: ["admin-login"],
  proxmoxInfrastructureInventory: CONTEST_MODE_INVENTORY
})
const NON_PREPARING_STATUSES = ["draft", "running", "finalizing", "finished", "canceled"] as const

const seedContest = (status: ContestStatus) =>
  Effect.gen(function* () {
    const contest = makeContest({ id: ContestId.make(`c-mode-${status}`), edition: 2, status, revision: 4 })
    yield* (yield* ContestRepo).create(contest)
    return contest
  })

// 別 Operation が global lock (unfinished 1 本) を掴んでいる状態。
const seedUnfinishedOperation = (contestId: ContestId) =>
  Effect.gen(function* () {
    yield* (yield* OperationRepo).enqueue({
      contestId,
      kind: "reconcile",
      actor: { kind: "scheduler" },
      planDigest: "d-busy",
      contestRevision: 4,
      steps: [{ stepKey: "reconcile:busy", ordinal: 0, inputSummary: "{}", continueOnError: false }]
    })
  })

describe("POST /api/admin/contests/:contestId/enter-contest-mode", () => {
  const path = (contestId: ContestId) => `/api/admin/contests/${contestId}/enter-contest-mode`

  it.effect("未認証は 401", () =>
    Effect.gen(function* () {
      const contest = yield* seedContest("preparing")
      const res = yield* (yield* HttpClient.HttpClient).post(path(contest.id))
      expect(res.status).toBe(401)
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  it.effect("非 admin は 403", () =>
    Effect.gen(function* () {
      const contest = yield* seedContest("preparing")
      const { cookieHeader } = yield* login({ githubLogin: "u-ecm-nonadmin", githubId: 8300 })
      const res = yield* postJson(cookieHeader, path(contest.id), {})
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  it.effect("存在しない contest は 404", () =>
    Effect.gen(function* () {
      const { cookieHeader } = yield* asAdmin()
      const res = yield* postJson(cookieHeader, path(ContestId.make("nope")), {})
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  it.effect.each(NON_PREPARING_STATUSES)("%s の Contest は 409 InvalidContestTransition で Operation を積まない", (status) =>
    Effect.gen(function* () {
      const contest = yield* seedContest(status)
      const { cookieHeader } = yield* asAdmin()
      const res = yield* postJson(cookieHeader, path(contest.id), {})
      expect(res.status).toBe(409)
      expect(yield* res.json).toMatchObject({ _tag: "InvalidContestTransition", from: status })
      expect(yield* (yield* OperationRepo).hasUnfinished).toBe(false)
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  it.effect("preparing なら devvm 停止 → benchvm 起動の step を持つ enter_contest_mode Operation を積む", () =>
    Effect.gen(function* () {
      const contest = yield* seedContest("preparing")
      const { cookieHeader } = yield* asAdmin()
      const res = yield* postJson(cookieHeader, path(contest.id), {})
      expect(res.status).toBe(200)
      const op = Schema.decodeUnknownSync(Operation)(yield* res.json)
      expect([op.kind, op.status, op.contestId]).toEqual(["enter_contest_mode", "queued", contest.id])
      const steps = yield* (yield* OperationRepo).listSteps(OperationId.make(op.id))
      // worker の registry は ENTER_CONTEST_MODE_STEP_KEYS の step だけを mode handler に
      // 渡す。順序は modeOperation.test.ts が spec の順で固定している。
      expect(steps.map((s) => [s.ordinal, s.stepKey, s.continueOnError])).toEqual(
        ENTER_CONTEST_MODE_STEP_KEYS.map((key, i) => [i, key, false])
      )
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  it.effect("別 Operation が未完了なら 409 OperationalContestConflict", () =>
    Effect.gen(function* () {
      const contest = yield* seedContest("preparing")
      yield* seedUnfinishedOperation(contest.id)
      const { cookieHeader } = yield* asAdmin()
      const res = yield* postJson(cookieHeader, path(contest.id), {})
      expect(res.status).toBe(409)
      expect(yield* res.json).toMatchObject({ _tag: "OperationalContestConflict" })
    }).pipe(Effect.provide(OperationsTestLayer))
  )
})

describe("POST /api/admin/contests/:contestId/prepare-instances", () => {
  const path = (contestId: ContestId) => `/api/admin/contests/${contestId}/prepare-instances`

  it.effect("未認証は 401", () =>
    Effect.gen(function* () {
      const contest = yield* seedContest("preparing")
      const res = yield* (yield* HttpClient.HttpClient).post(path(contest.id))
      expect(res.status).toBe(401)
    }).pipe(Effect.provide(ContestModeTestLayer))
  )

  it.effect("非 admin は 403", () =>
    Effect.gen(function* () {
      const contest = yield* seedContest("preparing")
      const { cookieHeader } = yield* login({ githubLogin: "u-prep-nonadmin", githubId: 8400 })
      const res = yield* postJson(cookieHeader, path(contest.id), {})
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(ContestModeTestLayer))
  )

  it.effect("存在しない contest は 404", () =>
    Effect.gen(function* () {
      const { cookieHeader } = yield* asAdmin()
      const res = yield* postJson(cookieHeader, path(ContestId.make("nope")), {})
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(ContestModeTestLayer))
  )

  it.effect.each(NON_PREPARING_STATUSES)("%s の Contest は 409 InvalidContestTransition で Operation を積まない", (status) =>
    Effect.gen(function* () {
      const contest = yield* seedContest(status)
      const { cookieHeader } = yield* asAdmin()
      const res = yield* postJson(cookieHeader, path(contest.id), {})
      expect(res.status).toBe(409)
      expect(yield* res.json).toMatchObject({ _tag: "InvalidContestTransition", from: status })
      expect(yield* (yield* OperationRepo).hasUnfinished).toBe(false)
    }).pipe(Effect.provide(ContestModeTestLayer))
  )

  it.effect("normal mode (devvm 起動中) なら 409 ContestModeNotActive で Operation を積まない", () =>
    Effect.gen(function* () {
      const contest = yield* seedContest("preparing")
      const { cookieHeader } = yield* asAdmin()
      const res = yield* postJson(cookieHeader, path(contest.id), {})
      expect(res.status).toBe(409)
      expect(yield* res.json).toEqual({ _tag: "ContestModeNotActive", reason: "devvm_not_stopped" })
      expect(yield* (yield* OperationRepo).hasUnfinished).toBe(false)
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  it.effect("Proxmox inventory が読めなければ 503 ProviderUnavailable で Operation を積まない", () =>
    Effect.gen(function* () {
      const contest = yield* seedContest("preparing")
      const { cookieHeader } = yield* asAdmin()
      const res = yield* postJson(cookieHeader, path(contest.id), {})
      expect(res.status).toBe(503)
      expect(yield* res.json).toEqual({ _tag: "ProviderUnavailable", provider: "proxmox" })
      expect(yield* (yield* OperationRepo).hasUnfinished).toBe(false)
    }).pipe(
      Effect.provide(
        makeAppTestLayer({
          adminGithubLogins: ["admin-login"],
          proxmoxInfrastructureInventory: CONTEST_MODE_INVENTORY,
          proxmoxFailWith: { getInfrastructureInventory: new ProxmoxError({ cause: "simulated outage" }) }
        })
      )
    )
  )

  it.effect("競技モードの preparing なら converge_contest_instances 1 step の prepare Operation を積む", () =>
    Effect.gen(function* () {
      const contest = yield* seedContest("preparing")
      const { cookieHeader } = yield* asAdmin()
      const res = yield* postJson(cookieHeader, path(contest.id), {})
      expect(res.status).toBe(200)
      const op = Schema.decodeUnknownSync(Operation)(yield* res.json)
      expect([op.kind, op.status, op.contestId]).toEqual(["prepare", "queued", contest.id])
      const steps = yield* (yield* OperationRepo).listSteps(OperationId.make(op.id))
      // prepare handler は inputSummary の contestId で対象 Contest を再読する。
      expect(steps.map((s) => [s.stepKey, JSON.parse(s.inputSummary)])).toEqual([
        [PREPARE_STEP_KEY, { contestId: contest.id }]
      ])
    }).pipe(Effect.provide(ContestModeTestLayer))
  )

  it.effect("別 Operation が未完了なら 409 OperationalContestConflict", () =>
    Effect.gen(function* () {
      const contest = yield* seedContest("preparing")
      yield* seedUnfinishedOperation(contest.id)
      const { cookieHeader } = yield* asAdmin()
      const res = yield* postJson(cookieHeader, path(contest.id), {})
      expect(res.status).toBe(409)
      expect(yield* res.json).toMatchObject({ _tag: "OperationalContestConflict" })
    }).pipe(Effect.provide(ContestModeTestLayer))
  )
})

// Admin Web が確認 checkbox の前に出す「影響を受ける VMID / hostname」。web 側に
// VMID 定数や hostname 導出を複製させないため server が返す。
describe("GET /api/admin/contests/:contestId/preparation-plan", () => {
  const path = (contestId: ContestId) => `/api/admin/contests/${contestId}/preparation-plan`

  it.effect("非 admin は 403", () =>
    Effect.gen(function* () {
      const contest = yield* seedContest("preparing")
      const { cookieHeader: cookie } = yield* login({ githubLogin: "u-plan-nonadmin", githubId: 8500 })
      const res = yield* (yield* HttpClient.HttpClient).get(path(contest.id), { headers: { cookie } })
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  it.effect("存在しない contest は 404", () =>
    Effect.gen(function* () {
      const { cookieHeader: cookie } = yield* asAdmin()
      const res = yield* (yield* HttpClient.HttpClient).get(path(ContestId.make("nope")), { headers: { cookie } })
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  it.effect("mode 切替で止める / 起動する VM と、prepare が作る枠・既存 Instance を返す", () =>
    Effect.gen(function* () {
      const contest = yield* seedContest("preparing")
      const team = makeTeam({ id: TeamId.make("t-plan-1"), contestId: contest.id, teamNumber: 1, name: "team1", desiredInstanceCount: 2 })
      yield* (yield* TeamRepo).create(team)
      yield* (yield* InstanceRepo).create(
        new Instance({
          id: InstanceId.make("i-plan-1-1"),
          contestId: contest.id,
          teamId: team.id,
          index: 1,
          vmid: 1101,
          privateIp: "10.100.1.11",
          status: "running",
          progress: [],
          errorMessage: Option.none(),
          createdAt: 1000,
          updatedAt: 1000
        })
      )
      const { cookieHeader: cookie } = yield* asAdmin()
      const res = yield* (yield* HttpClient.HttpClient).get(path(contest.id), { headers: { cookie } })
      expect(res.status).toBe(200)
      expect(yield* res.json).toEqual({
        contestId: contest.id,
        contestMode: {
          shutdownVm: { vmid: DEVVM_VMID, name: DEVVM_VM_NAME },
          startVm: { vmid: BENCHVM_VMID, name: BENCHVM_VM_NAME }
        },
        // instanceId は Overview の rehearsal が running の枠を対象に選ぶために使う。
        instanceSlots: [
          { teamNumber: 1, teamName: "team1", index: 1, hostname: "inucon-team1-1", vmid: 1101, instanceStatus: "running", instanceId: "i-plan-1-1" },
          { teamNumber: 1, teamName: "team1", index: 2, hostname: "inucon-team1-2", vmid: 1102, instanceStatus: null, instanceId: null }
        ]
      })
    }).pipe(Effect.provide(OperationsTestLayer))
  )
})


// Task 13: OperationDetail 用の single Operation 取得。step 一覧を ordinal
// 昇順で載せる。生 storagePath / bearer / email は載せない。
describe("GET /api/admin/operations/:operationId (Task 13)", () => {
  it.effect("非 admin は403", () =>
    Effect.gen(function* () {
      const { cookieHeader: cookie } = yield* login({
        githubLogin: "user1",
        githubId: 1,
        isAdmin: false
      })
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/admin/operations/op-1", { headers: { cookie } })
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  it.effect("存在しない operation は404", () =>
    Effect.gen(function* () {
      const { cookieHeader: cookie } = yield* asAdmin()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/admin/operations/op-missing", { headers: { cookie } })
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  it.effect("admin は200で Operation と steps (ordinal 昇順) を返す", () =>
    Effect.gen(function* () {
      yield* seedLegacy
      const ops = yield* OperationRepo
      const enqueued = yield* ops.enqueue({
        contestId: CONTEST_ID,
        kind: "reconcile",
        actor: { kind: "scheduler" },
        planDigest: "digest-for-detail",
        contestRevision: 1,
        steps: [
          { stepKey: "reconcile:step-a", ordinal: 0, inputSummary: "{}", continueOnError: false },
          { stepKey: "reconcile:step-b", ordinal: 1, inputSummary: "{}", continueOnError: true }
        ]
      })
      const { cookieHeader: cookie } = yield* asAdmin()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get(`/api/admin/operations/${enqueued.id}`, { headers: { cookie } })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as {
        id: string
        kind: string
        status: string
        planDigest: string
        sanitizedError: unknown
        steps: ReadonlyArray<{ stepKey: string; ordinal: number; attempt: number; continueOnError: boolean }>
      }
      expect(body.id).toBe(enqueued.id)
      expect(body.kind).toBe("reconcile")
      expect(body.planDigest).toBe("digest-for-detail")
      expect(body.sanitizedError).toBeNull()
      expect(body.steps.map((s) => s.stepKey)).toEqual(["reconcile:step-a", "reconcile:step-b"])
      expect(body.steps[0].ordinal).toBe(0)
      expect(body.steps[1].continueOnError).toBe(true)
    }).pipe(Effect.provide(OperationsTestLayer))
  )
})

// Task 13: ContestAdmin の Operations タブ用一覧。createdAt DESC + limit clamp。
describe("GET /api/admin/contests/:contestId/operations (Task 13)", () => {
  it.effect("非 admin は403", () =>
    Effect.gen(function* () {
      const { cookieHeader: cookie } = yield* login({
        githubLogin: "user1",
        githubId: 1,
        isAdmin: false
      })
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get(`/api/admin/contests/${CONTEST_ID}/operations`, {
        headers: { cookie }
      })
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  it.effect("存在しない contest は404", () =>
    Effect.gen(function* () {
      const { cookieHeader: cookie } = yield* asAdmin()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get(`/api/admin/contests/${ContestId.make("nope")}/operations`, {
        headers: { cookie }
      })
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  it.effect("createdAt DESC で最新 Operation を先頭に返す", () =>
    Effect.gen(function* () {
      yield* seedLegacy
      const ops = yield* OperationRepo
      const first = yield* ops.enqueue({
        contestId: CONTEST_ID,
        kind: "reconcile",
        actor: { kind: "scheduler" },
        planDigest: "d1",
        contestRevision: 1,
        steps: [{ stepKey: "s", ordinal: 0, inputSummary: "{}", continueOnError: false }]
      })
      yield* ops.cancel(first.id, 5000)
      const second = yield* ops.enqueue({
        contestId: CONTEST_ID,
        kind: "backup",
        actor: { kind: "scheduler" },
        planDigest: "d2",
        contestRevision: 1,
        steps: [{ stepKey: "s", ordinal: 0, inputSummary: "{}", continueOnError: false }]
      })
      const { cookieHeader: cookie } = yield* asAdmin()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get(`/api/admin/contests/${CONTEST_ID}/operations`, {
        headers: { cookie }
      })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as ReadonlyArray<{ id: string; kind: string; createdAt: number }>
      expect(body.length).toBe(2)
      // createdAt DESC を検証。同 ms に落ちても id (先頭は second) を含めた 2 件が
      // 返ることを確認する (実 SQL は created_at DESC, id DESC で tie-break)。
      expect(body[0].createdAt).toBeGreaterThanOrEqual(body[1].createdAt)
      const ids = new Set(body.map((op) => op.id))
      expect(ids.has(first.id)).toBe(true)
      expect(ids.has(second.id)).toBe(true)
      expect(body.map((op) => op.kind).sort()).toEqual(["backup", "reconcile"])
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  it.effect("limit=1000 は 100 に clamp する (200 で返る)", () =>
    Effect.gen(function* () {
      yield* seedLegacy
      const { cookieHeader: cookie } = yield* asAdmin()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get(`/api/admin/contests/${CONTEST_ID}/operations?limit=1000`, {
        headers: { cookie }
      })
      expect(res.status).toBe(200)
    }).pipe(Effect.provide(OperationsTestLayer))
  )
})

// POST /api/admin/operations/:operationId/cancel (AdminOnly)。遷移規則
// (queued / failed / blocked のみ) は OperationRepo.cancel が持つので、ここでは
// 認可・status ごとの可否・cancel で global lock が外れることを境界で確かめる。
describe("POST /api/admin/operations/:operationId/cancel", () => {
  const CANCEL_CONTEST_ID = ContestId.make("c-cancel")

  // Operation を worker と同じ repo 遷移で指定 status まで進める。
  const seedOperation = (status: OperationStatus) =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.create(
        makeContest({ id: CANCEL_CONTEST_ID, edition: 2, status: "preparing", revision: 1 })
      )
      const ops = yield* OperationRepo
      const op = yield* ops.enqueue({
        contestId: CANCEL_CONTEST_ID,
        kind: "enter_contest_mode",
        actor: { kind: "scheduler" },
        planDigest: "digest-cancel",
        contestRevision: 1,
        steps: [{ stepKey: "step-a", ordinal: 0, inputSummary: "{}", continueOnError: false }]
      })
      if (status === "canceled") yield* ops.cancel(op.id, 1)
      if (status !== "queued" && status !== "canceled") {
        const stepId = Option.getOrThrow(yield* ops.claimNext(1)).id
        const err = sanitizeOperationError({ _tag: "ProxmoxError" })
        if (status === "succeeded") yield* ops.completeStep(stepId, "ok", 2)
        if (status === "failed") yield* ops.failStep(stepId, err, Option.none(), 2)
        if (status === "blocked") yield* ops.blockStep(stepId, err, 2)
      }
      expect(yield* statusOf(op.id)).toBe(status)
      return op.id
    })

  const statusOf = (id: OperationId) =>
    OperationRepo.pipe(
      Effect.flatMap((ops) => ops.findById(id)),
      Effect.map((op) => Option.getOrThrow(op).status)
    )

  const postCancel = (cookie: string | null, id: string) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return yield* client.post(
        `/api/admin/operations/${id}/cancel`,
        cookie === null ? {} : { headers: { cookie } }
      )
    })

  it.effect("未認証は 401 で、Operation は blocked のまま", () =>
    Effect.gen(function* () {
      const id = yield* seedOperation("blocked")
      const res = yield* postCancel(null, id)
      expect(res.status).toBe(401)
      expect(yield* statusOf(id)).toBe("blocked")
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  it.effect("非 admin は 403 で、Operation は blocked のまま", () =>
    Effect.gen(function* () {
      const id = yield* seedOperation("blocked")
      const { cookieHeader } = yield* login({ githubLogin: "u-cancel-nonadmin", githubId: 8300 })
      const res = yield* postCancel(cookieHeader, id)
      expect(res.status).toBe(403)
      expect(yield* statusOf(id)).toBe("blocked")
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  it.effect("存在しない Operation は 404", () =>
    Effect.gen(function* () {
      const { cookieHeader: cookie } = yield* asAdmin()
      const res = yield* postCancel(cookie, "op-missing")
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  for (const status of ["queued", "failed", "blocked"] as const) {
    it.effect(`${status} は 200 で canceled の Operation を返し、DB も canceled になる`, () =>
      Effect.gen(function* () {
        const id = yield* seedOperation(status)
        const { cookieHeader: cookie } = yield* asAdmin()
        const res = yield* postCancel(cookie, id)
        expect(res.status).toBe(200)
        const body = Schema.decodeUnknownSync(Operation)(yield* res.json)
        expect(body.id).toBe(id)
        expect(body.status).toBe("canceled")
        expect(body.finishedAt).not.toBeNull()
        expect(yield* statusOf(id)).toBe("canceled")
      }).pipe(Effect.provide(OperationsTestLayer))
    )
  }

  for (const status of ["running", "succeeded", "canceled"] as const) {
    it.effect(`${status} は 409 InvalidOperationTransition で拒否し、状態を変えない`, () =>
      Effect.gen(function* () {
        const id = yield* seedOperation(status)
        const { cookieHeader: cookie } = yield* asAdmin()
        const res = yield* postCancel(cookie, id)
        expect(res.status).toBe(409)
        expect(yield* res.json).toEqual({ _tag: "InvalidOperationTransition", from: status, to: "canceled" })
        expect(yield* statusOf(id)).toBe(status)
      }).pipe(Effect.provide(OperationsTestLayer))
    )
  }

  // runbook / UI の「running は lease 切れを待っても cancel できない」の根拠。
  // resumeExpired は step だけを queued に戻し、Operation は running のまま残る。
  it.effect("running は lease 切れで step が queued に戻っても 409 のまま", () =>
    Effect.gen(function* () {
      const id = yield* seedOperation("running")
      const ops = yield* OperationRepo
      expect(yield* ops.resumeExpired(Number.MAX_SAFE_INTEGER)).toBe(1)
      const { cookieHeader: cookie } = yield* asAdmin()
      const res = yield* postCancel(cookie, id)
      expect(res.status).toBe(409)
      expect(yield* statusOf(id)).toBe("running")
    }).pipe(Effect.provide(OperationsTestLayer))
  )

  it.effect("blocked を cancel すると global lock が外れ、同じ Contest で次の Operation を enqueue できる", () =>
    Effect.gen(function* () {
      const id = yield* seedOperation("blocked")
      const { cookieHeader: cookie } = yield* asAdmin()
      const startPath = `/api/admin/contests/${CANCEL_CONTEST_ID}/start`

      const locked = yield* postJson(cookie, startPath, { expectedRevision: 1 })
      expect(locked.status).toBe(409)
      expect(yield* locked.json).toEqual({ _tag: "OperationalContestConflict" })

      expect((yield* postCancel(cookie, id)).status).toBe(200)

      const res = yield* postJson(cookie, startPath, { expectedRevision: 1 })
      expect(res.status).toBe(200)
      expect(yield* res.json).toMatchObject({ kind: "start", status: "queued", contestId: CANCEL_CONTEST_ID })
    }).pipe(Effect.provide(OperationsTestLayer))
  )
})
