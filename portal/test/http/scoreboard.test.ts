import { HttpClient } from "@effect/platform"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { login } from "../support/login.js"
import { TestLayer } from "../support/apiTestHelpers.js"

describe("GET /api/scoreboard", () => {
  it.effect("cookie なしは401", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/scoreboard")
      expect(res.status).toBe(401)
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
