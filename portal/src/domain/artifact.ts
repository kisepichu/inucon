import { Schema } from "effect"
import { ArtifactId, ContestId } from "./ids.js"

// Task 6: 開催回ごとの成果物メタデータ(scoreboard JSON/CSV / DB snapshot 等)。
// 実ファイルは server-side の /backups PVC に置き、行には path / sha256 /
// off_host_status(off-host verification 状況)を持つ。unique(contestId, kind)
// なので regenerate は in-place 上書き(atomic rename + row update)扱い。
export const ARTIFACT_KINDS = ["scoreboard", "scoreboard_csv", "snapshot"] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

export const OFF_HOST_STATUSES = ["not_applicable", "pending", "verified"] as const
export type OffHostStatus = (typeof OFF_HOST_STATUSES)[number]

export class Artifact extends Schema.Class<Artifact>("Artifact")({
  id: ArtifactId,
  contestId: ContestId,
  kind: Schema.Literal(...ARTIFACT_KINDS),
  storagePath: Schema.String,
  sha256: Schema.String,
  sizeBytes: Schema.Int.pipe(Schema.nonNegative()),
  offHostStatus: Schema.Literal(...OFF_HOST_STATUSES),
  verifiedAt: Schema.OptionFromNullOr(Schema.Int),
  createdAt: Schema.Int
}) {}
