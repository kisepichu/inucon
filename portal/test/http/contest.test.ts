import { HttpClient } from "@effect/platform"
import { it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { describe, expect } from "vitest"
import { ContestRepo } from "../../src/application/ports.js"
import { login } from "../support/login.js"
import { TestLayer, asAdmin } from "../support/apiTestHelpers.js"
import { makeContest } from "../support/factories.js"
import { ContestId } from "../../src/domain/ids.js"

// Task 1: Contest schema が拡大しても GET /api/contest の shape はそのまま
// 「Contest struct 全体を返す」契約 (shared/src/schemas.ts の Contest)。
// 単一 Contest 運用のブリッジ層で、Task 3 では contest-scoped archive API に
// 差し替えられる。

describe("GET /api/contest", () => {
  it.effect("コンテスト未作成は404", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/contest")
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("cookie なしでも404(コンテスト未作成、公開エンドポイント)", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/contest")
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("作成済みなら200でコンテスト情報が返る", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      const contest = makeContest({
        id: ContestId.make("contest-1"),
        status: "preparing",
        edition: 1,
        name: "INUCON",
        problemKey: "private-isu",
        problemRevision: "legacy-2026-07-08",
        templateVmid: 9100,
        instanceQuota: 3
      })
      yield* contests.create(contest)

      const { cookieHeader } = yield* login()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/contest", { headers: { cookie: cookieHeader } })
      expect(res.status).toBe(200)
      const body = yield* res.json
      expect(body).toStrictEqual({
        id: "contest-1",
        edition: 1,
        name: "INUCON",
        problemKey: "private-isu",
        problemRevision: "legacy-2026-07-08",
        templateVmid: 9100,
        status: "preparing",
        instanceQuota: 3,
        scheduledStartAt: null,
        scheduledEndAt: null,
        accessClosesAt: null,
        cleanupAt: null,
        accessClosedAt: null,
        cleanupCompletedAt: null,
        startedAt: null,
        finalizingAt: null,
        finishedAt: null,
        canceledAt: null,
        revision: 1
      })
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("POST /api/admin/contest/start", () => {
  const start = (cookieHeader: string) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return yield* client.post("/api/admin/contest/start", { headers: { cookie: cookieHeader } })
    })

  it.effect("非 admin は403", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.create(makeContest({ status: "preparing" }))
      const { cookieHeader } = yield* login({ isAdmin: false })
      const res = yield* start(cookieHeader)
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("コンテスト未作成は404", () =>
    Effect.gen(function* () {
      const { cookieHeader } = yield* asAdmin()
      const res = yield* start(cookieHeader)
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("preparing からは running になり startedAt が刻まれる", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.create(makeContest({ status: "preparing" }))
      const { cookieHeader } = yield* asAdmin()
      const res = yield* start(cookieHeader)
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { status: string; startedAt: number | null; revision: number }
      expect(body.status).toBe("running")
      expect(body.startedAt).not.toBeNull()
      expect(body.revision).toBe(2)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("running からの start は409(不正遷移)", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.create(makeContest({ status: "running", startedAt: Option.some(1) }))
      const { cookieHeader } = yield* asAdmin()
      const res = yield* start(cookieHeader)
      expect(res.status).toBe(409)
      const body = yield* res.json
      expect(body).toStrictEqual({ _tag: "InvalidContestTransition", from: "running", to: "running" })
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("POST /api/admin/contest/finish (compat bridge: running -> finalizing -> finished)", () => {
  const finish = (cookieHeader: string) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return yield* client.post("/api/admin/contest/finish", { headers: { cookie: cookieHeader } })
    })

  it.effect("非 admin は403", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.create(makeContest({ status: "running" }))
      const { cookieHeader } = yield* login({ isAdmin: false })
      const res = yield* finish(cookieHeader)
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("コンテスト未作成は404", () =>
    Effect.gen(function* () {
      const { cookieHeader } = yield* asAdmin()
      const res = yield* finish(cookieHeader)
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("running からは finalizing -> finished を 1 save で通過し、finalizingAt/finishedAt が刻まれる", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.create(makeContest({ status: "running" }))
      const { cookieHeader } = yield* asAdmin()
      const res = yield* finish(cookieHeader)
      expect(res.status).toBe(200)
      const body = (yield* res.json) as {
        status: string
        finalizingAt: number | null
        finishedAt: number | null
        revision: number
      }
      expect(body.status).toBe("finished")
      expect(body.finalizingAt).not.toBeNull()
      expect(body.finishedAt).not.toBeNull()
      // beginFinalization + finishContest の 2 mutation で revision は +2
      expect(body.revision).toBe(3)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("preparing からの finish は409(beginFinalization が拒否)", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.create(makeContest({ status: "preparing" }))
      const { cookieHeader } = yield* asAdmin()
      const res = yield* finish(cookieHeader)
      expect(res.status).toBe(409)
      const body = yield* res.json
      expect(body).toStrictEqual({ _tag: "InvalidContestTransition", from: "preparing", to: "finalizing" })
    }).pipe(Effect.provide(TestLayer))
  )
})
