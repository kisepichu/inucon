import { Data } from "effect"
import type { ContestStatus } from "./contest.js"
import type { BenchJobStatus } from "./benchJob.js"
import type { BenchJobId, TeamId } from "./ids.js"

// Data.TaggedError(データのみ、Effect runtime 非依存)。
// ContestStatus / BenchJobStatus は contest.ts / benchJob.ts で定義される型のみを
// import type で参照する(実行時の循環 import を避けるため)。

export class InvalidContestTransition extends Data.TaggedError("InvalidContestTransition")<{
  from: ContestStatus
  to: ContestStatus
}> {}

export type JobAction = "start" | "recordProgress" | "finish" | "fail" | "cancel"

export class InvalidJobTransition extends Data.TaggedError("InvalidJobTransition")<{
  jobId: BenchJobId
  from: BenchJobStatus
  action: JobAction
}> {}

export class CannotCancelRunning extends Data.TaggedError("CannotCancelRunning")<{
  jobId: BenchJobId
}> {}

export class TargetIpOutOfSubnet extends Data.TaggedError("TargetIpOutOfSubnet")<{
  ip: string
  teamNumber: number
}> {}

export class TeamJobAlreadyQueued extends Data.TaggedError("TeamJobAlreadyQueued")<{
  teamId: TeamId
}> {}

export class ContestNotRunning extends Data.TaggedError("ContestNotRunning")<{
  status: ContestStatus
}> {}

// teams.team_number の UNIQUE 制約違反。TeamJobAlreadyQueued と同様、リポジトリ
// (SQLite 実装)が「INSERT ... WHERE NOT EXISTS ... RETURNING」の単一原子的操作
// で検出して返す(TOCTOU 回避、benchJobRepo.ts の insertIfAllowed と同じ形)。
export class TeamNumberConflict extends Data.TaggedError("TeamNumberConflict")<{
  teamNumber: number
}> {}

// instances.(team_id, idx) の UNIQUE 制約違反。TeamNumberConflict と同様、
// リポジトリ(SQLite 実装)が「INSERT ... WHERE NOT EXISTS ... RETURNING」の
// 単一原子的操作で検出して返す(TOCTOU 回避、benchJobRepo.ts の
// insertIfAllowed と同じ形)。
export class DuplicateInstanceIndex extends Data.TaggedError("DuplicateInstanceIndex")<{
  teamId: TeamId
  index: number
}> {}
