import { HttpClient } from "@effect/platform"
import { it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { describe, expect } from "vitest"
import { BenchJobRepo, ContestRepo, TeamRepo } from "../../src/application/ports.js"
import { login } from "../support/login.js"
import { TestLayer, asAdmin } from "../support/apiTestHelpers.js"
import { makeBenchJob, makeContest, makeTeam } from "../support/factories.js"
import { BenchJobId, ContestId, TeamId } from "../../src/domain/ids.js"

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

// Task 4: 公開 archive API。edition1 finished + edition2 running のフィクスチャで
// list/select/scoreboard 分離を検証する。canceled は list/detail のいずれからも
// 見えない(admin 経路のみ)。
describe("GET /api/contests (public archive list)", () => {
  const setupArchiveFixtures = Effect.gen(function* () {
    const contests = yield* ContestRepo
    const edition1 = makeContest({
      id: ContestId.make("contest-e1"),
      edition: 1,
      status: "finished",
      name: "INUCON",
      finishedAt: Option.some(1_000_000)
    })
    const edition2 = makeContest({
      id: ContestId.make("contest-e2"),
      edition: 2,
      status: "running",
      name: "INUCON 2",
      startedAt: Option.some(2_000_000)
    })
    const canceled = makeContest({
      id: ContestId.make("contest-canceled"),
      edition: 3,
      status: "canceled",
      name: "INUCON 3 (canceled)",
      canceledAt: Option.some(500)
    })
    // canceled から先に create しないと single_operational partial index に
    // ぶつからない(canceled は operational 集合の対象外)。
    yield* contests.create(edition1)
    yield* contests.create(edition2)
    yield* contests.create(canceled)
    return { edition1, edition2, canceled }
  })

  it.effect("cookie なしで200、edition 降順で canceled 除外の一覧が返る", () =>
    Effect.gen(function* () {
      const { edition1, edition2 } = yield* setupArchiveFixtures
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/contests")
      expect(res.status).toBe(200)
      const body = (yield* res.json) as ReadonlyArray<{ id: string; edition: number; status: string }>
      expect(body.map((c) => c.id)).toStrictEqual([edition2.id, edition1.id])
      expect(body.every((c) => c.status !== "canceled")).toBe(true)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("空 DB は 200 空配列(未 seed の初期状態)", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/contests")
      expect(res.status).toBe(200)
      const body = (yield* res.json) as ReadonlyArray<unknown>
      expect(body).toStrictEqual([])
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("GET /api/contests/:contestId (public detail)", () => {
  it.effect("finished contest は 200 で詳細が返る", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      const c = makeContest({
        id: ContestId.make("contest-detail-fin"),
        edition: 4,
        status: "finished",
        finishedAt: Option.some(9_000_000)
      })
      yield* contests.create(c)

      const client = yield* HttpClient.HttpClient
      const res = yield* client.get(`/api/contests/${c.id}`)
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { id: string; status: string; edition: number }
      expect(body.id).toBe(c.id)
      expect(body.status).toBe("finished")
      expect(body.edition).toBe(4)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("canceled contest は 404(監査経路は admin のみ)", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      const c = makeContest({
        id: ContestId.make("contest-detail-canceled"),
        edition: 5,
        status: "canceled",
        canceledAt: Option.some(1234)
      })
      yield* contests.create(c)

      const client = yield* HttpClient.HttpClient
      const res = yield* client.get(`/api/contests/${c.id}`)
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("存在しない contestId は 404", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/contests/no-such-contest")
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(TestLayer))
  )
})
