import { Either, Option, Schema } from "effect"
import type { Contest } from "./contest.js"
import {
  CannotCancelRunning,
  ContestNotRunning,
  InvalidJobTransition,
  TargetIpOutOfSubnet,
  TeamJobAlreadyQueued
} from "./errors.js"
import { BenchJobId, TeamId } from "./ids.js"
import { ipInTeamSubnet } from "./subnet.js"

export type BenchJobStatus = "queued" | "running" | "finished" | "canceled" | "failed"

export class BenchJob extends Schema.Class<BenchJob>("BenchJob")({
  id: BenchJobId,
  teamId: TeamId,
  targetIp: Schema.String,
  targetPort: Schema.Int.pipe(Schema.between(1, 65535)),
  status: Schema.Literal("queued", "running", "finished", "canceled", "failed"),
  score: Schema.OptionFromNullOr(Schema.Int),
  passed: Schema.OptionFromNullOr(Schema.Boolean),
  errorMessage: Schema.OptionFromNullOr(Schema.String),
  enqueuedAt: Schema.Int,
  startedAt: Schema.OptionFromNullOr(Schema.Int),
  finishedAt: Schema.OptionFromNullOr(Schema.Int),
  lastProgressAt: Schema.OptionFromNullOr(Schema.Int)
}) {}

// キュー不変条件のチェック(スペック §BenchJob):
// - Contest が running のときのみ enqueue 可
// - チームごと queued+running 合計 1 本まで(呼び出し元が activeJobCountForTeam を数える)
// - targetIp はチームサブネット内のみ
export const checkEnqueueAllowed = (args: {
  contest: Contest
  activeJobCountForTeam: number
  teamId: TeamId
  teamNumber: number
  targetIp: string
}): Either.Either<void, ContestNotRunning | TeamJobAlreadyQueued | TargetIpOutOfSubnet> => {
  if (args.contest.status !== "running") {
    return Either.left(new ContestNotRunning({ status: args.contest.status }))
  }
  if (args.activeJobCountForTeam > 0) {
    return Either.left(new TeamJobAlreadyQueued({ teamId: args.teamId }))
  }
  if (!ipInTeamSubnet(args.targetIp, args.teamNumber)) {
    return Either.left(new TargetIpOutOfSubnet({ ip: args.targetIp, teamNumber: args.teamNumber }))
  }
  return Either.right(undefined)
}

export const newJob = (args: {
  id: BenchJobId
  teamId: TeamId
  targetIp: string
  targetPort: number
  now: number
}): BenchJob =>
  new BenchJob({
    id: args.id,
    teamId: args.teamId,
    targetIp: args.targetIp,
    targetPort: args.targetPort,
    status: "queued",
    score: Option.none(),
    passed: Option.none(),
    errorMessage: Option.none(),
    enqueuedAt: args.now,
    startedAt: Option.none(),
    finishedAt: Option.none(),
    lastProgressAt: Option.none()
  })

export const startJob = (job: BenchJob, now: number): Either.Either<BenchJob, InvalidJobTransition> =>
  job.status === "queued"
    ? Either.right(
        new BenchJob({
          ...job,
          status: "running",
          startedAt: Option.some(now),
          lastProgressAt: Option.some(now)
        })
      )
    : Either.left(new InvalidJobTransition({ jobId: job.id, from: job.status, action: "start" }))

export const recordProgress = (job: BenchJob, now: number): Either.Either<BenchJob, InvalidJobTransition> =>
  job.status === "running"
    ? Either.right(new BenchJob({ ...job, lastProgressAt: Option.some(now) }))
    : Either.left(new InvalidJobTransition({ jobId: job.id, from: job.status, action: "recordProgress" }))

export const finishJob = (
  job: BenchJob,
  result: { score: number; passed: boolean },
  now: number
): Either.Either<BenchJob, InvalidJobTransition> =>
  job.status === "running"
    ? Either.right(
        new BenchJob({
          ...job,
          status: "finished",
          score: Option.some(result.score),
          passed: Option.some(result.passed),
          finishedAt: Option.some(now)
        })
      )
    : Either.left(new InvalidJobTransition({ jobId: job.id, from: job.status, action: "finish" }))

export const failJob = (
  job: BenchJob,
  message: string,
  now: number
): Either.Either<BenchJob, InvalidJobTransition> =>
  job.status === "running"
    ? Either.right(
        new BenchJob({
          ...job,
          status: "failed",
          errorMessage: Option.some(message),
          finishedAt: Option.some(now)
        })
      )
    : Either.left(new InvalidJobTransition({ jobId: job.id, from: job.status, action: "fail" }))

export const cancelJob = (job: BenchJob): Either.Either<BenchJob, CannotCancelRunning | InvalidJobTransition> => {
  if (job.status === "queued") {
    return Either.right(new BenchJob({ ...job, status: "canceled" }))
  }
  if (job.status === "running") {
    return Either.left(new CannotCancelRunning({ jobId: job.id }))
  }
  return Either.left(new InvalidJobTransition({ jobId: job.id, from: job.status, action: "cancel" }))
}

export const isTimedOut = (job: BenchJob, now: number, timeoutMillis: number): boolean => {
  if (job.status !== "running") return false
  return Option.match(job.lastProgressAt, {
    onNone: () => false,
    onSome: (lastProgressAt) => lastProgressAt + timeoutMillis < now
  })
}
