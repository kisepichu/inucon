import { HttpBody, HttpClient } from "@effect/platform"
import { it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { describe, expect } from "vitest"
import { CloudflareError, ContestRepo, InstanceRepo, OperationRepo, ResourceBindingRepo, TeamRepo } from "../../src/application/ports.js"
import { ContestId, InstanceId, ResourceBindingId, TeamId } from "../../src/domain/ids.js"
import { Instance } from "../../src/domain/instance.js"
import { ResourceBinding } from "../../src/domain/resourceBinding.js"
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
