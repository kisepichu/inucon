import { HttpApiBuilder } from "@effect/platform"
import { Effect, Option } from "effect"
import {
  api,
  CannotCancelRunning,
  ContestNotRunning,
  CurrentUser,
  Forbidden,
  InstanceNotRunning,
  InvalidJobTransition,
  NotFound,
  TargetIpOutOfSubnet,
  TeamJobAlreadyQueued
} from "shared"
import type { BenchJob } from "../../../domain/benchJob.js"
import {
  cancelBench,
  enqueueBenchJob,
  getBenchJobDetail,
  listBenchJobs
} from "../../../application/usecases/bench.js"

// domain の BenchJob(Option フィールド)を契約(shared)の BenchJob(null 許容)
// に変換する。teams.ts の toTeamMember と同じ方針(Option は境界を跨がない)。
const toBenchJobResponse = (job: BenchJob) => ({
  id: job.id,
  contestId: job.contestId,
  teamId: job.teamId,
  targetIp: job.targetIp,
  targetPort: job.targetPort,
  status: job.status,
  purpose: job.purpose,
  score: Option.getOrNull(job.score),
  passed: Option.getOrNull(job.passed),
  errorMessage: Option.getOrNull(job.errorMessage),
  enqueuedAt: job.enqueuedAt,
  startedAt: Option.getOrNull(job.startedAt),
  finishedAt: Option.getOrNull(job.finishedAt)
})

export const BenchLive = HttpApiBuilder.group(api, "bench", (handlers) =>
  handlers
    .handle("enqueueBench", ({ payload }) =>
      CurrentUser.pipe(
        Effect.flatMap((user) => enqueueBenchJob({ user, target: payload })),
        Effect.map(toBenchJobResponse),
        Effect.catchTags({
          ContestNotRunning: (e) => Effect.fail(new ContestNotRunning({ status: e.status })),
          TeamJobAlreadyQueued: (e) => Effect.fail(new TeamJobAlreadyQueued({ teamId: e.teamId })),
          TargetIpOutOfSubnet: (e) => Effect.fail(new TargetIpOutOfSubnet({ ip: e.ip, teamNumber: e.teamNumber })),
          NotInTeam: () => Effect.fail(new Forbidden()),
          // 他チームのインスタンス指定(application の Forbidden)→ 403。
          Forbidden: () => Effect.fail(new Forbidden()),
          InstanceNotFound: () => Effect.fail(new NotFound()),
          InstanceNotRunning: (e) => Effect.fail(new InstanceNotRunning({ instanceId: e.instanceId }))
        }),
        Effect.orDie
      )
    )
    .handle("listBenchJobs", ({ urlParams }) =>
      listBenchJobs({ teamId: urlParams.teamId }).pipe(
        Effect.map((jobs) => jobs.map(toBenchJobResponse)),
        Effect.orDie
      )
    )
    .handle("getBenchJob", ({ path }) =>
      CurrentUser.pipe(
        Effect.flatMap((user) => getBenchJobDetail({ user, jobId: path.id })),
        Effect.map(({ job, log }) => ({ ...toBenchJobResponse(job), log })),
        Effect.catchTag("Forbidden", () => Effect.fail(new Forbidden())),
        Effect.orDie
      )
    )
    .handle("cancelBenchJob", ({ path }) =>
      CurrentUser.pipe(
        Effect.flatMap((user) => cancelBench({ user, jobId: path.id })),
        Effect.map(toBenchJobResponse),
        Effect.catchTags({
          // チーム未所属ユーザーはどのジョブも操作できない(enqueue と同じ 403)。
          NotInTeam: () => Effect.fail(new Forbidden()),
          Forbidden: () => Effect.fail(new Forbidden()),
          CannotCancelRunning: (e) => Effect.fail(new CannotCancelRunning({ jobId: e.jobId })),
          InvalidJobTransition: (e) =>
            Effect.fail(new InvalidJobTransition({ jobId: e.jobId, from: e.from, action: e.action }))
        }),
        Effect.orDie
      )
    )
)
