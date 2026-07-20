import { HttpClient } from "@effect/platform"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { Contest } from "../../src/domain/contest.js"
import { ContestId } from "../../src/domain/ids.js"
import { ContestRepo } from "../../src/application/ports.js"
import { login } from "../support/login.js"
import { TestLayer, asAdmin } from "../support/apiTestHelpers.js"

describe("GET /api/contest", () => {
  it.effect("コンテスト未作成は404", () =>
    Effect.gen(function* () {
      const { cookieHeader } = yield* login()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/contest", { headers: { cookie: cookieHeader } })
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
      yield* contests.save(
        new Contest({ id: ContestId.make("contest-1"), name: "INUCON", problemKey: "private-isu", status: "preparing", instanceQuota: 3 })
      )

      const { cookieHeader } = yield* login()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/contest", { headers: { cookie: cookieHeader } })
      expect(res.status).toBe(200)
      const body = yield* res.json
      expect(body).toStrictEqual({
        id: "contest-1",
        name: "INUCON",
        problemKey: "private-isu",
        status: "preparing",
        instanceQuota: 3
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
      yield* contests.save(
        new Contest({ id: ContestId.make("contest-start-403"), name: "C", problemKey: "p", status: "preparing", instanceQuota: 3 })
      )
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

  it.effect("preparing からは running になる", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.save(
        new Contest({ id: ContestId.make("contest-start-ok"), name: "C", problemKey: "p", status: "preparing", instanceQuota: 3 })
      )
      const { cookieHeader } = yield* asAdmin()
      const res = yield* start(cookieHeader)
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { status: string }
      expect(body.status).toBe("running")
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("running からの start は409(不正遷移)", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.save(
        new Contest({ id: ContestId.make("contest-start-conflict"), name: "C", problemKey: "p", status: "running", instanceQuota: 3 })
      )
      const { cookieHeader } = yield* asAdmin()
      const res = yield* start(cookieHeader)
      expect(res.status).toBe(409)
      const body = yield* res.json
      expect(body).toStrictEqual({ _tag: "InvalidContestTransition", from: "running", to: "running" })
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("POST /api/admin/contest/finish", () => {
  const finish = (cookieHeader: string) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return yield* client.post("/api/admin/contest/finish", { headers: { cookie: cookieHeader } })
    })

  it.effect("非 admin は403", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.save(
        new Contest({ id: ContestId.make("contest-finish-403"), name: "C", problemKey: "p", status: "running", instanceQuota: 3 })
      )
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

  it.effect("running からは finished になる", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.save(
        new Contest({ id: ContestId.make("contest-finish-ok"), name: "C", problemKey: "p", status: "running", instanceQuota: 3 })
      )
      const { cookieHeader } = yield* asAdmin()
      const res = yield* finish(cookieHeader)
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { status: string }
      expect(body.status).toBe("finished")
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("preparing からの finish は409(不正遷移)", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      yield* contests.save(
        new Contest({ id: ContestId.make("contest-finish-conflict"), name: "C", problemKey: "p", status: "preparing", instanceQuota: 3 })
      )
      const { cookieHeader } = yield* asAdmin()
      const res = yield* finish(cookieHeader)
      expect(res.status).toBe(409)
      const body = yield* res.json
      expect(body).toStrictEqual({ _tag: "InvalidContestTransition", from: "preparing", to: "finished" })
    }).pipe(Effect.provide(TestLayer))
  )
})
