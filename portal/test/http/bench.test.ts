import { HttpBody, HttpClient } from "@effect/platform"
import { it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { describe, expect } from "vitest"
import { DEFAULT_TEST_CONTEST_ID, makeContest, makeInstance, makeTeam } from "../support/factories.js"
import { InstanceId, TeamId } from "../../src/domain/ids.js"
import { ContestRepo, InstanceRepo, TeamRepo } from "../../src/application/ports.js"
import { login } from "../support/login.js"
import { asAdmin, TestLayer } from "../support/apiTestHelpers.js"
import { RUNNER_TOKEN_TEST } from "../support/testApi.js"

// bench グループ + runner グループの E2E 相当テスト(スペック §テスト戦略)。
// 「enqueue → poll → progress → finish → scoreboard 反映」の一連は他チーム
// 407/403 やキュー不変条件の分岐と合わせてここに集約する。

let teamSeq = 0

// 各テストで running な Contest + 1 チーム + そのメンバーを用意する。
// TestLayer は it.effect ごとに新しい :memory: SQLite で fresh に build される
// (contest.test.ts 等と同じ前提)ため、テスト間の状態共有は無い。
const setup = (options?: { teamNumber?: number }) =>
  Effect.gen(function* () {
    teamSeq++
    const contests = yield* ContestRepo
    const existing = yield* contests.getOperational
    const contest = Option.isSome(existing)
      ? existing.value
      : yield* Effect.gen(function* () {
          const c = makeContest({ id: DEFAULT_TEST_CONTEST_ID, status: "running" })
          yield* contests.create(c)
          return c
        })

    const teams = yield* TeamRepo
    const teamNumber = options?.teamNumber ?? 60 + teamSeq
    const team = makeTeam({ id: TeamId.make(`team-bench-${teamSeq}`), name: `Team ${teamSeq}`, teamNumber })
    yield* teams.create(team)

    const { user, cookieHeader } = yield* login({ githubLogin: `bench-member-${teamSeq}`, githubId: teamSeq })
    yield* teams.setMembers(DEFAULT_TEST_CONTEST_ID, team.id, [user.id])

    return { contest, team, user, cookieHeader, teamNumber }
  })

const enqueue = (cookieHeader: string, payload: unknown) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return yield* client.post("/api/bench-jobs", { headers: { cookie: cookieHeader }, body: HttpBody.unsafeJson(payload) })
  })

const poll = () =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return yield* client.post("/api/runner/jobs/poll", {
      headers: { authorization: `Bearer ${RUNNER_TOKEN_TEST}` }
    })
  })

const progress = (jobId: string, payload: unknown) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return yield* client.post(`/api/runner/jobs/${jobId}/progress`, {
      headers: { authorization: `Bearer ${RUNNER_TOKEN_TEST}` },
      body: HttpBody.unsafeJson(payload)
    })
  })

const finish = (jobId: string, payload: unknown) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return yield* client.post(`/api/runner/jobs/${jobId}/finish`, {
      headers: { authorization: `Bearer ${RUNNER_TOKEN_TEST}` },
      body: HttpBody.unsafeJson(payload)
    })
  })

const getJob = (cookieHeader: string, jobId: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return yield* client.get(`/api/bench-jobs/${jobId}`, { headers: { cookie: cookieHeader } })
  })

const cancel = (cookieHeader: string, jobId: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return yield* client.post(`/api/bench-jobs/${jobId}/cancel`, { headers: { cookie: cookieHeader } })
  })

describe("enqueue → poll → progress → finish", () => {
  it.effect("正常系: 一連が通り、ログとスコアが反映される", () =>
    Effect.gen(function* () {
      const { cookieHeader, team, teamNumber } = yield* setup()

      const enqueueRes = yield* enqueue(cookieHeader, { targetIp: `10.100.${teamNumber}.5`, targetPort: 8080 })
      expect(enqueueRes.status).toBe(200)
      const enqueued = (yield* enqueueRes.json) as { id: string; status: string; teamId: string }
      expect(enqueued.status).toBe("queued")
      expect(enqueued.teamId).toBe(team.id)

      const pollRes = yield* poll()
      expect(pollRes.status).toBe(200)
      const polled = (yield* pollRes.json) as { job: { id: string; teamId: string; targetIp: string; targetPort: number; problemKey: string } | null }
      expect(polled.job).not.toBeNull()
      expect(polled.job?.id).toBe(enqueued.id)
      expect(polled.job?.teamId).toBe(team.id)
      expect(polled.job?.targetIp).toBe(`10.100.${teamNumber}.5`)
      expect(polled.job?.problemKey).toBe("private-isu")

      const progressRes = yield* progress(enqueued.id, { logChunk: "step1\n", partialScore: 10 })
      expect(progressRes.status).toBe(204)

      const finishRes = yield* finish(enqueued.id, { passed: true, score: 100, errorMessage: null, logTail: "step2\ndone\n" })
      expect(finishRes.status).toBe(204)

      const detailRes = yield* getJob(cookieHeader, enqueued.id)
      expect(detailRes.status).toBe(200)
      const detail = (yield* detailRes.json) as { status: string; score: number | null; passed: boolean | null; log: string }
      expect(detail.status).toBe("finished")
      expect(detail.score).toBe(100)
      expect(detail.passed).toBe(true)
      expect(detail.log).toBe("step1\nstep2\ndone\n")
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("errorMessage 付き finish は failed になる(実行自体の失敗)", () =>
    Effect.gen(function* () {
      const { cookieHeader, teamNumber } = yield* setup()

      const enqueueRes = yield* enqueue(cookieHeader, { targetIp: `10.100.${teamNumber}.5`, targetPort: 8080 })
      const enqueued = (yield* enqueueRes.json) as { id: string }

      yield* poll()

      const finishRes = yield* finish(enqueued.id, {
        passed: false,
        score: 0,
        errorMessage: "benchmarker crashed",
        logTail: "panic!\n"
      })
      expect(finishRes.status).toBe(204)

      const detailRes = yield* getJob(cookieHeader, enqueued.id)
      const detail = (yield* detailRes.json) as { status: string; errorMessage: string | null; log: string }
      expect(detail.status).toBe("failed")
      expect(detail.errorMessage).toBe("benchmarker crashed")
      expect(detail.log).toBe("panic!\n")
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("POST /api/runner/jobs/poll", () => {
  it.effect("空キューは { job: null }", () =>
    Effect.gen(function* () {
      const pollRes = yield* poll()
      expect(pollRes.status).toBe(200)
      const body = yield* pollRes.json
      expect(body).toStrictEqual({ job: null })
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("二重 poll: 2 本目は null(全体で running 1 本まで)", () =>
    Effect.gen(function* () {
      const { cookieHeader, teamNumber } = yield* setup()
      yield* enqueue(cookieHeader, { targetIp: `10.100.${teamNumber}.5`, targetPort: 8080 })

      const first = yield* poll()
      const firstBody = (yield* first.json) as { job: { id: string } | null }
      expect(firstBody.job).not.toBeNull()

      const second = yield* poll()
      const secondBody = yield* second.json
      expect(secondBody).toStrictEqual({ job: null })
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("cancel 済みジョブは poll に出ない", () =>
    Effect.gen(function* () {
      const { cookieHeader, teamNumber } = yield* setup()
      const enqueueRes = yield* enqueue(cookieHeader, { targetIp: `10.100.${teamNumber}.5`, targetPort: 8080 })
      const enqueued = (yield* enqueueRes.json) as { id: string }

      const cancelRes = yield* cancel(cookieHeader, enqueued.id)
      expect(cancelRes.status).toBe(200)

      const pollRes = yield* poll()
      const body = yield* pollRes.json
      expect(body).toStrictEqual({ job: null })
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("Contest が finished になったら queued が残っていても { job: null }(コンテスト終了でキューは閉じる)", () =>
    Effect.gen(function* () {
      const { cookieHeader, contest, teamNumber } = yield* setup()
      const enqueueRes = yield* enqueue(cookieHeader, { targetIp: `10.100.${teamNumber}.5`, targetPort: 8080 })
      expect(enqueueRes.status).toBe(200)

      const contests = yield* ContestRepo
      yield* contests.saveIfRevision(
        makeContest({ ...contest, status: "finalizing", revision: contest.revision + 1 }),
        contest.revision
      )

      const pollRes = yield* poll()
      expect(pollRes.status).toBe(200)
      const body = yield* pollRes.json
      expect(body).toStrictEqual({ job: null })
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("POST /api/runner/jobs/:id/progress", () => {
  it.effect("queued(まだ poll されていない)ジョブへの progress は 409", () =>
    Effect.gen(function* () {
      const { cookieHeader, teamNumber } = yield* setup()
      const enqueueRes = yield* enqueue(cookieHeader, { targetIp: `10.100.${teamNumber}.5`, targetPort: 8080 })
      const enqueued = (yield* enqueueRes.json) as { id: string }

      const res = yield* progress(enqueued.id, { logChunk: "x", partialScore: null })
      expect(res.status).toBe(409)
      const body = yield* res.json
      expect(body).toStrictEqual({ _tag: "InvalidJobTransition", jobId: enqueued.id, from: "queued", action: "recordProgress" })
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("GET /api/bench-jobs/:id", () => {
  it.effect("他チームのメンバーは 403(ログを含む詳細は自チーム + admin のみ)", () =>
    Effect.gen(function* () {
      const { cookieHeader, teamNumber } = yield* setup()
      const enqueueRes = yield* enqueue(cookieHeader, { targetIp: `10.100.${teamNumber}.5`, targetPort: 8080 })
      const enqueued = (yield* enqueueRes.json) as { id: string }

      const other = yield* setup()
      const res = yield* getJob(other.cookieHeader, enqueued.id)
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("admin は他チームのジョブでも 200", () =>
    Effect.gen(function* () {
      const { cookieHeader, teamNumber } = yield* setup()
      const enqueueRes = yield* enqueue(cookieHeader, { targetIp: `10.100.${teamNumber}.5`, targetPort: 8080 })
      const enqueued = (yield* enqueueRes.json) as { id: string }

      const { cookieHeader: adminCookie } = yield* asAdmin()
      const res = yield* getJob(adminCookie, enqueued.id)
      expect(res.status).toBe(200)
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("POST /api/bench-jobs: instanceId 指定", () => {
  it.effect("instanceId 指定時は Instance の privateIp / targetPort=80 で enqueue される", () =>
    Effect.gen(function* () {
      const { cookieHeader, team, teamNumber } = yield* setup()
      const instances = yield* InstanceRepo
      const instance = makeInstance({
        id: InstanceId.make("inst-bench-1"),
        teamId: team.id,
        index: 1,
        vmid: 1000 + teamNumber * 100 + 1,
        privateIp: `10.100.${teamNumber}.20`,
        status: "running",
        progress: ["clone_done", "configured", "started", "route_done", "access_done"]
      })
      yield* instances.create(instance)

      const res = yield* enqueue(cookieHeader, { instanceId: instance.id })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { targetIp: string; targetPort: number }
      expect(body.targetIp).toBe(`10.100.${teamNumber}.20`)
      expect(body.targetPort).toBe(80)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("他チームの instanceId は 403(privateIp をエラーボディに漏らさない)", () =>
    Effect.gen(function* () {
      const owner = yield* setup()
      const instances = yield* InstanceRepo
      const instance = makeInstance({
        id: InstanceId.make("inst-bench-other-team"),
        teamId: owner.team.id,
        index: 1,
        vmid: 1000 + owner.teamNumber * 100 + 1,
        privateIp: `10.100.${owner.teamNumber}.30`,
        status: "running",
        progress: ["clone_done", "configured", "started", "route_done", "access_done"]
      })
      yield* instances.create(instance)

      const attacker = yield* setup()
      const res = yield* enqueue(attacker.cookieHeader, { instanceId: instance.id })
      expect(res.status).toBe(403)
      const text = yield* res.text
      expect(text).not.toContain(`10.100.${owner.teamNumber}.30`)
    }).pipe(Effect.provide(TestLayer))
  )

  // Task 6 レビュー #3: running 以外(creating/deleting/deleted/failed)の
  // Instance を instanceId 指定で enqueue しようとすると、接続先が存在しない
  // (or もう存在しない)状態にジョブを投げてジョブ枠を浪費するだけなので
  // 明示的に拒否する。テーブル駆動で非 running 状態を一通り確認する。
  for (const status of ["creating", "deleting", "deleted", "failed"] as const) {
    it.effect(`instanceId が ${status} の Instance を指すと 409(InstanceNotRunning)で enqueue されない`, () =>
      Effect.gen(function* () {
        const { cookieHeader, team, teamNumber } = yield* setup()
        const instances = yield* InstanceRepo
        const instance = makeInstance({
          id: InstanceId.make(`inst-bench-notrunning-${status}`),
          teamId: team.id,
          index: 1,
          vmid: 1000 + teamNumber * 100 + 1,
          privateIp: `10.100.${teamNumber}.20`,
          status,
          errorMessage: status === "failed" ? Option.some("boom") : Option.none()
        })
        yield* instances.create(instance)

        const res = yield* enqueue(cookieHeader, { instanceId: instance.id })
        expect(res.status).toBe(409)
        const body = yield* res.json
        expect(body).toStrictEqual({ _tag: "InstanceNotRunning", instanceId: instance.id })

        // 何もキューに積まれていない(ジョブ枠を浪費しない)ことも確認する。
        const client = yield* HttpClient.HttpClient
        const listRes = yield* client.get("/api/bench-jobs", {
          headers: { cookie: cookieHeader },
          urlParams: { teamId: team.id }
        })
        const jobs = (yield* listRes.json) as ReadonlyArray<unknown>
        expect(jobs).toHaveLength(0)
      }).pipe(Effect.provide(TestLayer))
    )
  }
})

describe("POST /api/bench-jobs/:id/cancel", () => {
  it.effect("チーム未所属ユーザーは 403(500 にならない)", () =>
    Effect.gen(function* () {
      const { cookieHeader, teamNumber } = yield* setup()
      const enqueueRes = yield* enqueue(cookieHeader, { targetIp: `10.100.${teamNumber}.5`, targetPort: 8080 })
      const enqueued = (yield* enqueueRes.json) as { id: string }

      const { cookieHeader: noTeamCookie } = yield* login({ githubLogin: "bench-no-team", githubId: 9000 })
      const res = yield* cancel(noTeamCookie, enqueued.id)
      expect(res.status).toBe(403)
    }).pipe(Effect.provide(TestLayer))
  )
})
