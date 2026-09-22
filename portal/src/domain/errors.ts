import { Data } from "effect"
import type { ContestStatus } from "./contest.js"
import type { BenchJobStatus } from "./benchJob.js"
import type { InstanceStatus } from "./instance.js"
import type { OperationStatus } from "./operation.js"
import type { BenchJobId, InstanceId, TeamId } from "./ids.js"

// Data.TaggedError(データのみ、Effect runtime 非依存)。
// ContestStatus / BenchJobStatus は contest.ts / benchJob.ts で定義される型のみを
// import type で参照する(実行時の循環 import を避けるため)。

// Task 1 (multi-edition lifecycle): 6状態機械の不正遷移。canceled も含む。
export class InvalidContestTransition extends Data.TaggedError("InvalidContestTransition")<{
  from: ContestStatus
  to: ContestStatus
}> {}

// Task 6: Durable Operation の状態機械(operation.ts)における不正遷移。
// Contest/Job/Instance の InvalidXxxTransition と同型。
export class InvalidOperationTransition extends Data.TaggedError("InvalidOperationTransition")<{
  from: OperationStatus
  to: OperationStatus
}> {}

// Task 8: beginContestPreparation の pre-save ガードでチェック失敗があったときに
// 返す。details として readiness key の識別子(previous_cleanup / unfinished_operation /
// transitional_instance など)の配列を運ぶ。UI 側は「まだ準備できない」旨と
// 個々の失敗 key を提示できる。
export type PreparationBlockReason =
  | "previous_cleanup"
  | "unfinished_operation"
  | "transitional_instance"

export class ContestNotReadyForPreparation extends Data.TaggedError(
  "ContestNotReadyForPreparation"
)<{
  readonly failingChecks: ReadonlyArray<PreparationBlockReason>
}> {}

// draft -> preparing の schedule 検証で unset/順序違反が見つかったときに返す。
// beginPreparation で生成され、admin API は 422 にマップする(Task 5)。
export type InvalidContestScheduleReason =
  | "missing_schedule"
  | "start_not_before_end"
  | "access_close_before_end"
  | "cleanup_before_access_close"

export class InvalidContestSchedule extends Data.TaggedError("InvalidContestSchedule")<{
  reason: InvalidContestScheduleReason
}> {}

// Task 3: Contest ライフサイクル関連のリポジトリ由来 conflict。ContestRepo.create /
// saveIfRevision が SQLite の partial unique index / 楽観ロックで検出して返す
// (TeamNumberConflict と同じ「リポジトリが原子的に検出」形式)。
export class ContestEditionConflict extends Data.TaggedError("ContestEditionConflict")<{
  edition: number
}> {}

export class OperationalContestConflict extends Data.TaggedError("OperationalContestConflict")<{}> {}

export class ContestRevisionConflict extends Data.TaggedError("ContestRevisionConflict")<{
  expected: number
  actual: number
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

// Instance の状態機械(instance.ts)における不正遷移。InvalidContestTransition /
// InvalidJobTransition と同じ形。
export class InvalidInstanceTransition extends Data.TaggedError("InvalidInstanceTransition")<{
  instanceId: InstanceId
  from: InstanceStatus
  to: InstanceStatus
}> {}
