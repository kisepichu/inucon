import { Option } from "effect"
import type { BenchJobPurpose, BenchJobStatus } from "../../src/domain/benchJob.js"
import { BenchJob } from "../../src/domain/benchJob.js"
import { Contest } from "../../src/domain/contest.js"
import type { InstanceStatus, ProvisionStep } from "../../src/domain/instance.js"
import { Instance } from "../../src/domain/instance.js"
import { BenchJobId, ContestId, InstanceId, OperationId, TeamId, UserId } from "../../src/domain/ids.js"
import { Operation } from "../../src/domain/operation.js"
import type { OperationActor, OperationKind, OperationStatus } from "../../src/domain/operation.js"
import { Team } from "../../src/domain/team.js"
import { TeamInvite } from "../../src/domain/teamInvite.js"

let operationSeq = 0

export type MakeOperationOverrides = {
  readonly id?: Operation["id"]
  readonly contestId?: Operation["contestId"]
  readonly kind?: OperationKind
  readonly status?: OperationStatus
  readonly actor?: OperationActor
  readonly planDigest?: string
  readonly contestRevision?: number
  readonly sanitizedError?: Operation["sanitizedError"]
  readonly createdAt?: number
  readonly startedAt?: Operation["startedAt"]
  readonly finishedAt?: Operation["finishedAt"]
}

export const makeOperation = (overrides: MakeOperationOverrides = {}): Operation => {
  operationSeq += 1
  const id =
    overrides.id ?? OperationId.make(`00000000-0000-0000-0000-op${String(operationSeq).padStart(10, "0")}`)
  return new Operation({
    id,
    contestId: overrides.contestId ?? DEFAULT_TEST_CONTEST_ID,
    kind: overrides.kind ?? "prepare",
    status: overrides.status ?? "queued",
    actor: overrides.actor ?? { kind: "scheduler" },
    planDigest: overrides.planDigest ?? "digest",
    contestRevision: overrides.contestRevision ?? 1,
    sanitizedError: overrides.sanitizedError ?? Option.none(),
    createdAt: overrides.createdAt ?? 0,
    startedAt: overrides.startedAt ?? Option.none(),
    finishedAt: overrides.finishedAt ?? Option.none()
  })
}

// Task 1: Contest スキーマが 20 フィールドに拡大したため、テストでは常に
// makeContest(overrides) を経由して既定値を注入する。既定は「draft と互換な
// スケジュール未設定・revision=1」。overrides で必要な差分だけ足す。
export type MakeContestOverrides = Partial<Omit<Contest, "id">> & { id?: Contest["id"] }

let contestSeq = 0

const nextContestId = (): Contest["id"] => {
  contestSeq += 1
  return ContestId.make(`00000000-0000-0000-0000-${String(contestSeq).padStart(12, "0")}`)
}

// Task 3: すべての scoped 集約テスト用に「1 つの共有 contest」の既定値。個別
// テストが自分の contestId を持ちたい場合は overrides で id を指定する。
export const DEFAULT_TEST_CONTEST_ID = ContestId.make("00000000-0000-0000-0000-cccccccccccc")

export const makeContest = (overrides: MakeContestOverrides = {}): Contest =>
  new Contest({
    id: overrides.id ?? nextContestId(),
    edition: overrides.edition ?? 1,
    name: overrides.name ?? "INUCON",
    problemKey: overrides.problemKey ?? "private-isu",
    problemRevision: overrides.problemRevision ?? "legacy-2026-07-08",
    templateVmid: overrides.templateVmid ?? 9100,
    status: overrides.status ?? "draft",
    instanceQuota: overrides.instanceQuota ?? 3,
    scheduledStartAt: overrides.scheduledStartAt ?? Option.none(),
    scheduledEndAt: overrides.scheduledEndAt ?? Option.none(),
    accessClosesAt: overrides.accessClosesAt ?? Option.none(),
    cleanupAt: overrides.cleanupAt ?? Option.none(),
    accessClosedAt: overrides.accessClosedAt ?? Option.none(),
    cleanupCompletedAt: overrides.cleanupCompletedAt ?? Option.none(),
    startedAt: overrides.startedAt ?? Option.none(),
    finalizingAt: overrides.finalizingAt ?? Option.none(),
    finishedAt: overrides.finishedAt ?? Option.none(),
    canceledAt: overrides.canceledAt ?? Option.none(),
    revision: overrides.revision ?? 1
  })

// Team / Instance / BenchJob / TeamInvite の scoped 既定値。デフォルトは
// DEFAULT_TEST_CONTEST_ID にひもづく。個別テストは overrides.contestId で
// 別 contest を指定できる。
export const makeTeam = (overrides: Partial<Team> & { id: TeamId; teamNumber: number; name: string }): Team =>
  new Team({
    id: overrides.id,
    contestId: overrides.contestId ?? DEFAULT_TEST_CONTEST_ID,
    name: overrides.name,
    teamNumber: overrides.teamNumber,
    desiredInstanceCount: overrides.desiredInstanceCount ?? 3
  })

export const makeInstance = (overrides: {
  id: InstanceId
  teamId: TeamId
  index: number
  vmid: number
  privateIp: string
  status?: InstanceStatus
  progress?: ReadonlyArray<ProvisionStep>
  errorMessage?: Option.Option<string>
  createdAt?: number
  updatedAt?: number
  contestId?: ContestId
}): Instance =>
  new Instance({
    id: overrides.id,
    contestId: overrides.contestId ?? DEFAULT_TEST_CONTEST_ID,
    teamId: overrides.teamId,
    index: overrides.index,
    vmid: overrides.vmid,
    privateIp: overrides.privateIp,
    status: overrides.status ?? "running",
    progress: overrides.progress ?? [],
    errorMessage: overrides.errorMessage ?? Option.none(),
    createdAt: overrides.createdAt ?? 0,
    updatedAt: overrides.updatedAt ?? overrides.createdAt ?? 0
  })

export const makeBenchJob = (overrides: {
  id: BenchJobId
  teamId: TeamId
  targetIp: string
  targetPort?: number
  status?: BenchJobStatus
  purpose?: BenchJobPurpose
  score?: Option.Option<number>
  passed?: Option.Option<boolean>
  errorMessage?: Option.Option<string>
  enqueuedAt?: number
  startedAt?: Option.Option<number>
  finishedAt?: Option.Option<number>
  lastProgressAt?: Option.Option<number>
  contestId?: ContestId
}): BenchJob =>
  new BenchJob({
    id: overrides.id,
    contestId: overrides.contestId ?? DEFAULT_TEST_CONTEST_ID,
    teamId: overrides.teamId,
    targetIp: overrides.targetIp,
    targetPort: overrides.targetPort ?? 80,
    status: overrides.status ?? "queued",
    purpose: overrides.purpose ?? "competition",
    score: overrides.score ?? Option.none(),
    passed: overrides.passed ?? Option.none(),
    errorMessage: overrides.errorMessage ?? Option.none(),
    enqueuedAt: overrides.enqueuedAt ?? 0,
    startedAt: overrides.startedAt ?? Option.none(),
    finishedAt: overrides.finishedAt ?? Option.none(),
    lastProgressAt: overrides.lastProgressAt ?? Option.none()
  })

export const makeInvite = (overrides: {
  githubLogin: string
  teamId: TeamId
  email: string
  invitedAt?: number
  contestId?: ContestId
}): TeamInvite =>
  new TeamInvite({
    contestId: overrides.contestId ?? DEFAULT_TEST_CONTEST_ID,
    githubLogin: overrides.githubLogin,
    teamId: overrides.teamId,
    email: overrides.email,
    invitedAt: overrides.invitedAt ?? 0
  })

// 未使用の import 警告を抑えつつ、テストから型として使いやすいよう再エクスポート。
export type { BenchJob, Contest, Instance, Team, TeamInvite }
export { UserId }
