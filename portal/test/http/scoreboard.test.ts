import { HttpClient } from "@effect/platform"
import { it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { describe, expect } from "vitest"
import { BenchJobId, ContestId, TeamId } from "../../src/domain/ids.js"
import { BenchJobRepo, ContestRepo, TeamRepo } from "../../src/application/ports.js"
import { makeBenchJob, makeContest, makeTeam } from "../support/factories.js"
import { login } from "../support/login.js"
import { TestLayer } from "../support/apiTestHelpers.js"

describe("GET /api/scoreboard", () => {
  it.effect("cookie なしでも200と配列が返る(公開エンドポイント)", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/scoreboard")
      expect(res.status).toBe(200)
      const body = (yield* res.json) as ReadonlyArray<{
        teamId: string
        teamName: string
        bestScore: number | null
        latestScore: number | null
        latestAt: number | null
      }>
      expect(Array.isArray(body)).toBe(true)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("ログイン済みで200と配列が返る", () =>
    Effect.gen(function* () {
      const { cookieHeader } = yield* login()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/scoreboard", { headers: { cookie: cookieHeader } })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as ReadonlyArray<{
        teamId: string
        teamName: string
        bestScore: number | null
        latestScore: number | null
        latestAt: number | null
      }>
      expect(Array.isArray(body)).toBe(true)
    }).pipe(Effect.provide(TestLayer))
  )
})

// Task 4: contest スコープ scoreboard(/api/contests/:contestId/scoreboard)。
// 別 contest のスコアが混ざらないこと、canceled も admin 経路以外では 404 を
// 返すこと、そして /api/scoreboard(compat)は getDisplay が選んだ contest の
// scoreboard を返すことを検証する。
describe("GET /api/contests/:contestId/scoreboard", () => {
  it.effect("edition1 と edition2 の scoreboard は互いに混ざらない", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      // finalized な edition1 と running な edition2 を用意。single-operational
      // 制約を守るため canceled 状態から作って先に edition1 を保存 → edition2 は
      // running で保存(edition1 は finished なので operational 集合外)。
      const edition1 = makeContest({
        id: ContestId.make("sb-e1"),
        edition: 1,
        status: "finished",
        finishedAt: Option.some(1000)
      })
      const edition2 = makeContest({
        id: ContestId.make("sb-e2"),
        edition: 2,
        status: "running",
        startedAt: Option.some(2000)
      })
      yield* contests.create(edition1)
      yield* contests.create(edition2)

      const teamE1 = makeTeam({
        id: TeamId.make("team-sb-e1"),
        contestId: edition1.id,
        name: "Team E1",
        teamNumber: 1
      })
      const teamE2 = makeTeam({
        id: TeamId.make("team-sb-e2"),
        contestId: edition2.id,
        name: "Team E2",
        teamNumber: 1
      })
      yield* teams.create(teamE1)
      yield* teams.create(teamE2)

      yield* jobs.insertIfAllowed(
        makeBenchJob({
          id: BenchJobId.make("job-e1"),
          contestId: edition1.id,
          teamId: teamE1.id,
          targetIp: "10.100.1.11",
          status: "finished",
          purpose: "competition",
          score: Option.some(1077),
          passed: Option.some(true),
          enqueuedAt: 100,
          startedAt: Option.some(200),
          finishedAt: Option.some(300)
        })
      )
      yield* jobs.insertIfAllowed(
        makeBenchJob({
          id: BenchJobId.make("job-e2"),
          contestId: edition2.id,
          teamId: teamE2.id,
          targetIp: "10.100.1.11",
          status: "finished",
          purpose: "competition",
          score: Option.some(500),
          passed: Option.some(true),
          enqueuedAt: 2100,
          startedAt: Option.some(2200),
          finishedAt: Option.some(2300)
        })
      )

      const client = yield* HttpClient.HttpClient
      const res1 = yield* client.get(`/api/contests/${edition1.id}/scoreboard`)
      expect(res1.status).toBe(200)
      const body1 = (yield* res1.json) as ReadonlyArray<{ teamId: string; bestScore: number | null }>
      expect(body1.map((r) => r.bestScore)).toStrictEqual([1077])

      const res2 = yield* client.get(`/api/contests/${edition2.id}/scoreboard`)
      expect(res2.status).toBe(200)
      const body2 = (yield* res2.json) as ReadonlyArray<{ teamId: string; bestScore: number | null }>
      expect(body2.map((r) => r.bestScore)).toStrictEqual([500])
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("canceled contest の scoreboard は 404", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      const c = makeContest({
        id: ContestId.make("sb-canceled"),
        edition: 7,
        status: "canceled",
        canceledAt: Option.some(5)
      })
      yield* contests.create(c)

      const client = yield* HttpClient.HttpClient
      const res = yield* client.get(`/api/contests/${c.id}/scoreboard`)
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("存在しない contestId の scoreboard は 404", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/contests/no-such/scoreboard")
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("GET /api/scoreboard(compat: getDisplay)", () => {
  it.effect("running の contest がある間は running edition の scoreboard を返す", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const edition1 = makeContest({
        id: ContestId.make("sbc-e1"),
        edition: 1,
        status: "finished",
        finishedAt: Option.some(1000)
      })
      const edition2 = makeContest({
        id: ContestId.make("sbc-e2"),
        edition: 2,
        status: "running",
        startedAt: Option.some(2000)
      })
      yield* contests.create(edition1)
      yield* contests.create(edition2)

      const teamE2 = makeTeam({
        id: TeamId.make("team-sbc-e2"),
        contestId: edition2.id,
        name: "Team E2 Compat",
        teamNumber: 1
      })
      yield* teams.create(teamE2)
      yield* jobs.insertIfAllowed(
        makeBenchJob({
          id: BenchJobId.make("job-sbc-e2"),
          contestId: edition2.id,
          teamId: teamE2.id,
          targetIp: "10.100.1.11",
          status: "finished",
          purpose: "competition",
          score: Option.some(999),
          passed: Option.some(true),
          enqueuedAt: 2100,
          startedAt: Option.some(2200),
          finishedAt: Option.some(2300)
        })
      )

      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/scoreboard")
      expect(res.status).toBe(200)
      const body = (yield* res.json) as ReadonlyArray<{ teamId: string; bestScore: number | null }>
      expect(body.map((r) => r.bestScore)).toStrictEqual([999])
    }).pipe(Effect.provide(TestLayer))
  )
})
