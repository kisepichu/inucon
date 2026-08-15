import { HttpBody, HttpClient } from "@effect/platform"
import { it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { describe, expect } from "vitest"
import { ContestRepo, InviteRepo, TeamRepo } from "../../src/application/ports.js"
import { ContestId, TeamId } from "../../src/domain/ids.js"
import { login } from "../support/login.js"
import { TestLayer, asAdmin } from "../support/apiTestHelpers.js"
import { makeContest, makeInvite, makeTeam } from "../support/factories.js"

// Task 5: /api/admin/contests 群の HTTP レイヤ挙動を検証する。cookie
// 認可(AdminOnly)と主要ステータスコード(200/404/409/422)のみを
// 集中的に確認する — 深い挙動は test/application/contestAdmin.test.ts。

const postJson = (cookieHeader: string, path: string, payload: unknown) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const body = yield* HttpBody.json(payload).pipe(Effect.orDie)
    return yield* client.post(path, { headers: { cookie: cookieHeader }, body })
  })

const patchJson = (cookieHeader: string, path: string, payload: unknown) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const body = yield* HttpBody.json(payload).pipe(Effect.orDie)
    return yield* client.patch(path, { headers: { cookie: cookieHeader }, body })
  })

describe("POST /api/admin/contests (create draft)", () => {
  it.effect("非 admin は403", () =>
    Effect.gen(function* () {
      const { cookieHeader: cookie } = yield* login({ githubLogin: "user1", githubId: 1, isAdmin: false })
      const res = yield* postJson(cookie, "/api/admin/contests", {
        edition: 2,
        name: "n",
        problemKey: "private-isu",
        problemRevision: "r",
        templateVmid: 9100,
        instanceQuota: 3,
        scheduledStartAt: null,
        scheduledEndAt: null,
        accessClosesAt: null,
        cleanupAt: null
      })
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("admin は200で新規 draft を返す", () =>
    Effect.gen(function* () {
      const { cookieHeader: cookie } = yield* asAdmin()
      const res = yield* postJson(cookie, "/api/admin/contests", {
        edition: 2,
        name: "INUCON #2",
        problemKey: "private-isu",
        problemRevision: "2026-08",
        templateVmid: 9100,
        instanceQuota: 3,
        scheduledStartAt: null,
        scheduledEndAt: null,
        accessClosesAt: null,
        cleanupAt: null
      })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { status: string; edition: number; revision: number }
      expect(body.status).toBe("draft")
      expect(body.edition).toBe(2)
      expect(body.revision).toBe(1)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("edition 重複は409", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.create(
        makeContest({ id: ContestId.make("c-existing"), edition: 2, status: "draft" })
      )
      const { cookieHeader: cookie } = yield* asAdmin()
      const res = yield* postJson(cookie, "/api/admin/contests", {
        edition: 2,
        name: "dup",
        problemKey: "private-isu",
        problemRevision: "r",
        templateVmid: 9100,
        instanceQuota: 3,
        scheduledStartAt: null,
        scheduledEndAt: null,
        accessClosesAt: null,
        cleanupAt: null
      })
      expect(res.status).toBe(409)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("schedule 順序違反は422", () =>
    Effect.gen(function* () {
      const { cookieHeader: cookie } = yield* asAdmin()
      const res = yield* postJson(cookie, "/api/admin/contests", {
        edition: 3,
        name: "bad",
        problemKey: "private-isu",
        problemRevision: "r",
        templateVmid: 9100,
        instanceQuota: 3,
        scheduledStartAt: 200,
        scheduledEndAt: 100,
        accessClosesAt: 200,
        cleanupAt: null
      })
      expect(res.status).toBe(422)
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("GET /api/admin/contests (list)", () => {
  it.effect("includeCanceled 省略時は canceled を返さない", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.create(
        makeContest({ id: ContestId.make("c-live"), edition: 1, status: "draft" })
      )
      yield* contests.create(
        makeContest({ id: ContestId.make("c-canceled"), edition: 2, status: "canceled" })
      )
      const { cookieHeader: cookie } = yield* asAdmin()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/admin/contests", { headers: { cookie } })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as ReadonlyArray<{ id: string }>
      expect(body.map((c) => c.id)).toStrictEqual(["c-live"])
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("includeCanceled=true で canceled を含む", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.create(
        makeContest({ id: ContestId.make("c-live"), edition: 1, status: "draft" })
      )
      yield* contests.create(
        makeContest({ id: ContestId.make("c-canceled"), edition: 2, status: "canceled" })
      )
      const { cookieHeader: cookie } = yield* asAdmin()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/admin/contests?includeCanceled=true", {
        headers: { cookie }
      })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as ReadonlyArray<{ id: string }>
      expect(body.map((c) => c.id).sort()).toStrictEqual(["c-canceled", "c-live"].sort())
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("非 admin は403", () =>
    Effect.gen(function* () {
      const { cookieHeader: cookie } = yield* login({ githubLogin: "u", githubId: 1, isAdmin: false })
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/admin/contests", { headers: { cookie } })
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("GET /api/admin/contests/:contestId (detail)", () => {
  it.effect("canceled でも 200 で返る(監査用)", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.create(
        makeContest({
          id: ContestId.make("c-canceled-detail"),
          edition: 9,
          status: "canceled",
          canceledAt: Option.some(1)
        })
      )
      const { cookieHeader: cookie } = yield* asAdmin()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/admin/contests/c-canceled-detail", {
        headers: { cookie }
      })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { id: string; status: string }
      expect(body.status).toBe("canceled")
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("存在しない ID は404", () =>
    Effect.gen(function* () {
      const { cookieHeader: cookie } = yield* asAdmin()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/admin/contests/no-such", { headers: { cookie } })
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("PATCH /api/admin/contests/:contestId (update draft)", () => {
  it.effect("成功は200で revision +1", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      const draft = makeContest({
        id: ContestId.make("c-upd"),
        edition: 4,
        status: "draft",
        revision: 1
      })
      yield* contests.create(draft)
      const { cookieHeader: cookie } = yield* asAdmin()
      const res = yield* patchJson(cookie, `/api/admin/contests/${draft.id}`, {
        expectedRevision: 1,
        patch: { name: "renamed" }
      })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { revision: number; name: string }
      expect(body.revision).toBe(2)
      expect(body.name).toBe("renamed")
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("stale revision は409", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      const draft = makeContest({
        id: ContestId.make("c-stale"),
        edition: 4,
        status: "draft",
        revision: 5
      })
      yield* contests.create(draft)
      const { cookieHeader: cookie } = yield* asAdmin()
      const res = yield* patchJson(cookie, `/api/admin/contests/${draft.id}`, {
        expectedRevision: 1,
        patch: { name: "x" }
      })
      expect(res.status).toBe(409)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("draft/preparing 以外は409(遷移不能)", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      const running = makeContest({
        id: ContestId.make("c-run"),
        edition: 4,
        status: "running",
        revision: 3
      })
      yield* contests.create(running)
      const { cookieHeader: cookie } = yield* asAdmin()
      const res = yield* patchJson(cookie, `/api/admin/contests/${running.id}`, {
        expectedRevision: 3,
        patch: { name: "x" }
      })
      expect(res.status).toBe(409)
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("POST /api/admin/contests/:contestId/prepare (begin preparation)", () => {
  it.effect("完全な schedule で200、preparing になる", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      const draft = makeContest({
        id: ContestId.make("c-prep"),
        edition: 6,
        status: "draft",
        revision: 1,
        scheduledStartAt: Option.some(100),
        scheduledEndAt: Option.some(200),
        accessClosesAt: Option.some(300)
      })
      yield* contests.create(draft)
      const { cookieHeader: cookie } = yield* asAdmin()
      const res = yield* postJson(cookie, `/api/admin/contests/${draft.id}/prepare`, {
        expectedRevision: 1
      })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { status: string; revision: number }
      expect(body.status).toBe("preparing")
      expect(body.revision).toBe(2)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("schedule 未設定は422", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      const draft = makeContest({
        id: ContestId.make("c-prep2"),
        edition: 6,
        status: "draft",
        revision: 1
      })
      yield* contests.create(draft)
      const { cookieHeader: cookie } = yield* asAdmin()
      const res = yield* postJson(cookie, `/api/admin/contests/${draft.id}/prepare`, {
        expectedRevision: 1
      })
      expect(res.status).toBe(422)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("他 operational Contest 存在で409", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.create(
        makeContest({ id: ContestId.make("c-op"), edition: 5, status: "running" })
      )
      const draft = makeContest({
        id: ContestId.make("c-prep3"),
        edition: 7,
        status: "draft",
        revision: 1,
        scheduledStartAt: Option.some(100),
        scheduledEndAt: Option.some(200),
        accessClosesAt: Option.some(300)
      })
      yield* contests.create(draft)
      const { cookieHeader: cookie } = yield* asAdmin()
      const res = yield* postJson(cookie, `/api/admin/contests/${draft.id}/prepare`, {
        expectedRevision: 1
      })
      expect(res.status).toBe(409)
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("POST /api/admin/contests/:contestId/cancel", () => {
  it.effect("draft から cancel すると200、invites が消える", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      const teams = yield* TeamRepo
      const invites = yield* InviteRepo
      const draft = makeContest({
        id: ContestId.make("c-cancel"),
        edition: 8,
        status: "draft",
        revision: 1
      })
      yield* contests.create(draft)
      const team = makeTeam({
        id: TeamId.make("t-cancel"),
        contestId: draft.id,
        teamNumber: 1,
        name: "t1"
      })
      yield* teams.create(team)
      yield* invites.create(
        makeInvite({
          contestId: draft.id,
          githubLogin: "pending",
          teamId: team.id,
          email: "p@example.com"
        })
      )
      const { cookieHeader: cookie } = yield* asAdmin()
      const res = yield* postJson(cookie, `/api/admin/contests/${draft.id}/cancel`, {
        expectedRevision: 1
      })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { status: string }
      expect(body.status).toBe("canceled")
      const remaining = yield* invites.listByTeam(draft.id, team.id)
      expect(remaining).toStrictEqual([])
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("running からの cancel は409", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      const running = makeContest({
        id: ContestId.make("c-run-cancel"),
        edition: 9,
        status: "running",
        revision: 2
      })
      yield* contests.create(running)
      const { cookieHeader: cookie } = yield* asAdmin()
      const res = yield* postJson(cookie, `/api/admin/contests/${running.id}/cancel`, {
        expectedRevision: 2
      })
      expect(res.status).toBe(409)
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("POST /api/admin/contests/:contestId/roster/copy", () => {
  it.effect("target draft に source の team/members/invites を複製する", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      const teams = yield* TeamRepo
      const invites = yield* InviteRepo
      const source = makeContest({
        id: ContestId.make("c-src"),
        edition: 1,
        status: "finished",
        finishedAt: Option.some(1000)
      })
      const target = makeContest({
        id: ContestId.make("c-tgt"),
        edition: 2,
        status: "draft"
      })
      yield* contests.create(source)
      yield* contests.create(target)
      const srcTeam = makeTeam({
        id: TeamId.make("src-t1"),
        contestId: source.id,
        teamNumber: 1,
        name: "team1",
        desiredInstanceCount: 3
      })
      yield* teams.create(srcTeam)
      yield* invites.create(
        makeInvite({
          contestId: source.id,
          githubLogin: "invited",
          teamId: srcTeam.id,
          email: "i@example.com"
        })
      )
      const { cookieHeader: cookie } = yield* asAdmin()
      const res = yield* postJson(cookie, `/api/admin/contests/${target.id}/roster/copy`, {
        sourceContestId: source.id
      })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as ReadonlyArray<{ id: string; contestId: string; teamNumber: number }>
      expect(body).toHaveLength(1)
      expect(body[0].contestId).toBe(target.id)
      expect(body[0].teamNumber).toBe(1)
      expect(body[0].id).not.toBe(srcTeam.id)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("source が存在しないと404", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      const target = makeContest({ id: ContestId.make("c-tgt2"), edition: 2, status: "draft" })
      yield* contests.create(target)
      const { cookieHeader: cookie } = yield* asAdmin()
      const res = yield* postJson(cookie, `/api/admin/contests/${target.id}/roster/copy`, {
        sourceContestId: "no-such-source"
      })
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(TestLayer))
  )
})
