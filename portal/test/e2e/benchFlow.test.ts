import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { makeContest } from "../support/factories.js"
import { ContestRepo } from "../../src/application/ports.js"
import { asAdmin, makeApiClient, makeRunnerApiClient, TestLayer } from "../support/apiTestHelpers.js"
import { login } from "../support/login.js"

// Task 8 の E2E シナリオ(スペック §テスト戦略): admin がチーム作成 →
// メンバー割当 → instance 登録 → contest start → メンバーが enqueue →
// runner poll → progress×2 → finish → scoreboard 反映 → ジョブ詳細でログ
// 全文、を本物の api(shared)に対して HttpApiClient(契約経由)で 1 本通す。
// Contest 行そのものを作る API は無い(admin/contest/start は既存 Contest の
// 遷移のみ)ため、bench.test.ts の setup と同様に ContestRepo へ直接 seed する。
describe("E2E: チーム作成からベンチ実行・スコアボード反映まで", () => {
  it.effect("一連のシナリオが通り、スコアボードとログ全文に反映される", () =>
    Effect.gen(function* () {
      const teamNumber = 90

      const contests = yield* ContestRepo
      yield* contests.save(makeContest({ status: "preparing" }))

      // 1. admin がチームを作る。
      const { cookieHeader: adminCookie } = yield* asAdmin()
      const adminClient = yield* makeApiClient(adminCookie)
      const team = yield* adminClient.teams.createTeam({ payload: { name: "E2E Team", teamNumber } })

      // 2. メンバーをログインさせ、チームに割り当てる。
      const { cookieHeader: memberCookie } = yield* login({ githubLogin: "e2e-member", githubId: 9001 })
      yield* adminClient.teams.setTeamMembers({
        path: { id: team.id },
        payload: { githubLogins: ["e2e-member"] }
      })

      // 3. instance を登録する。
      const instance = yield* adminClient.instances.createInstance({
        payload: { teamId: team.id, index: 1, privateIp: `10.100.${teamNumber}.20` }
      })

      // 4. コンテストを開始する。
      const started = yield* adminClient.admin.startContest()
      expect(started.status).toBe("running")

      // 5. メンバーが instance 指定で enqueue する(targetIp/targetPort は
      // instance から解決され、targetPort は 80 固定になる)。
      const memberClient = yield* makeApiClient(memberCookie)
      const job = yield* memberClient.bench.enqueueBench({ payload: { instanceId: instance.id } })
      expect(job.status).toBe("queued")
      expect(job.teamId).toBe(team.id)
      expect(job.targetIp).toBe(instance.privateIp)
      expect(job.targetPort).toBe(80)

      // 6. runner が poll し、problemKey 込みでジョブを受け取る。
      const runnerClient = yield* makeRunnerApiClient()
      const polled = yield* runnerClient.runner.pollJob()
      expect(polled.job?.id).toBe(job.id)
      expect(polled.job?.teamId).toBe(team.id)
      expect(polled.job?.problemKey).toBe("private-isu")

      // 7. progress を 2 回報告する(ログは蓄積される)。
      yield* runnerClient.runner.reportProgress({
        path: { id: job.id },
        payload: { logChunk: "step1\n", partialScore: 10 }
      })
      yield* runnerClient.runner.reportProgress({
        path: { id: job.id },
        payload: { logChunk: "step2\n", partialScore: 50 }
      })

      // 8. finish を報告する。
      yield* runnerClient.runner.reportFinish({
        path: { id: job.id },
        payload: { passed: true, score: 100, errorMessage: null, logTail: "done\n" }
      })

      // 9. スコアボードに反映される(全員参照可)。
      const scoreboard = yield* memberClient.scoreboard.getScoreboard()
      const entry = scoreboard.find((e) => e.teamId === team.id)
      expect(entry).toBeDefined()
      expect(entry?.teamName).toBe("E2E Team")
      expect(entry?.bestScore).toBe(100)
      expect(entry?.latestScore).toBe(100)
      // latestAt は finish 時刻で、null ではなく妥当な数値である
      expect(entry?.latestAt).not.toBeNull()
      expect(typeof entry?.latestAt).toBe("number")

      // 10. ジョブ詳細でログ全文が確認できる(自チームメンバーのみ)。
      const detail = yield* memberClient.bench.getBenchJob({ path: { id: job.id } })
      expect(detail.status).toBe("finished")
      expect(detail.score).toBe(100)
      expect(detail.passed).toBe(true)
      expect(detail.log).toBe("step1\nstep2\ndone\n")
    }).pipe(Effect.provide(TestLayer))
  )
})
