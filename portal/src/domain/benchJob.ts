import { Either, Option, Schema } from "effect"
import type { Contest } from "./contest.js"
import {
  CannotCancelRunning,
  ContestNotRunning,
  InvalidJobTransition,
  TargetIpOutOfSubnet,
  TeamJobAlreadyQueued
} from "./errors.js"
import { BenchJobId, ContestId, TeamId } from "./ids.js"
import { ipInTeamSubnet } from "./subnet.js"

export type BenchJobStatus = "queued" | "running" | "finished" | "canceled" | "failed"
export type BenchJobPurpose = "rehearsal" | "competition"

export class BenchJob extends Schema.Class<BenchJob>("BenchJob")({
  id: BenchJobId,
  contestId: ContestId,
  teamId: TeamId,
  targetIp: Schema.String,
  targetPort: Schema.Int.pipe(Schema.between(1, 65535)),
  status: Schema.Literal("queued", "running", "finished", "canceled", "failed"),
  purpose: Schema.Literal("rehearsal", "competition"),
  score: Schema.OptionFromNullOr(Schema.Int),
  passed: Schema.OptionFromNullOr(Schema.Boolean),
  errorMessage: Schema.OptionFromNullOr(Schema.String),
  enqueuedAt: Schema.Int,
  startedAt: Schema.OptionFromNullOr(Schema.Int),
  finishedAt: Schema.OptionFromNullOr(Schema.Int),
  lastProgressAt: Schema.OptionFromNullOr(Schema.Int)
}) {}

// キュー不変条件のチェック(スペック §BenchJob、Task 3 更新):
// - purpose='rehearsal' は Contest が preparing のときのみ許可
// - purpose='competition' は Contest が running のときのみ許可
// - targetIp はチームサブネット内のみ
// 「チームごと queued+running 合計 1 本」は TOCTOU-safe に強制する必要が
// あるため、SQL レイヤの benchJobRepo.insertIfAllowed (NOT EXISTS) が
// 唯一の enforcer。domain 側で件数を渡すと race で必ずずれるので、
// ここでは扱わない。TeamJobAlreadyQueued は SQL 側からのみ発火する。
export const checkEnqueueAllowed = (args: {
  contest: Contest
  purpose: BenchJobPurpose
  teamNumber: number
  targetIp: string
}): Either.Either<void, ContestNotRunning | TargetIpOutOfSubnet> => {
  const expectedStatus = args.purpose === "rehearsal" ? "preparing" : "running"
  if (args.contest.status !== expectedStatus) {
    return Either.left(new ContestNotRunning({ status: args.contest.status }))
  }
  if (!ipInTeamSubnet(args.targetIp, args.teamNumber)) {
    return Either.left(new TargetIpOutOfSubnet({ ip: args.targetIp, teamNumber: args.teamNumber }))
  }
  return Either.right(undefined)
}

export const newJob = (args: {
  id: BenchJobId
  contestId: ContestId
  teamId: TeamId
  targetIp: string
  targetPort: number
  purpose: BenchJobPurpose
  now: number
}): BenchJob =>
  new BenchJob({
    id: args.id,
    contestId: args.contestId,
    teamId: args.teamId,
    targetIp: args.targetIp,
    targetPort: args.targetPort,
    status: "queued",
    purpose: args.purpose,
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
