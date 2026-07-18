import { Either, Schema } from "effect"
import { ContestId } from "./ids.js"
import { InvalidContestTransition } from "./errors.js"

export type ContestStatus = "preparing" | "running" | "finished"

export class Contest extends Schema.Class<Contest>("Contest")({
  id: ContestId,
  name: Schema.String,
  problemKey: Schema.String,
  status: Schema.Literal("preparing", "running", "finished"),
  // チームごとのインスタンス上限(Phase 3、スペック §Instance 集約 不変条件1)。
  // migration 0002 で contests.instance_quota が NOT NULL DEFAULT 3 として
  // 追加されている(DB 側は Task 2-3 で先行済み。ドメインへの反映は Task 4)。
  instanceQuota: Schema.Int.pipe(Schema.positive())
}) {}

export const startContest = (c: Contest): Either.Either<Contest, InvalidContestTransition> =>
  c.status === "preparing"
    ? Either.right(new Contest({ ...c, status: "running" }))
    : Either.left(new InvalidContestTransition({ from: c.status, to: "running" }))

export const finishContest = (c: Contest): Either.Either<Contest, InvalidContestTransition> =>
  c.status === "running"
    ? Either.right(new Contest({ ...c, status: "finished" }))
    : Either.left(new InvalidContestTransition({ from: c.status, to: "finished" }))
