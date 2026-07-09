import { Either, Schema } from "effect"
import { ContestId } from "./ids.js"
import { InvalidContestTransition } from "./errors.js"

export type ContestStatus = "preparing" | "running" | "finished"

export class Contest extends Schema.Class<Contest>("Contest")({
  id: ContestId,
  name: Schema.String,
  problemKey: Schema.String,
  status: Schema.Literal("preparing", "running", "finished")
}) {}

export const startContest = (c: Contest): Either.Either<Contest, InvalidContestTransition> =>
  c.status === "preparing"
    ? Either.right(new Contest({ ...c, status: "running" }))
    : Either.left(new InvalidContestTransition({ from: c.status, to: "running" }))

export const finishContest = (c: Contest): Either.Either<Contest, InvalidContestTransition> =>
  c.status === "running"
    ? Either.right(new Contest({ ...c, status: "finished" }))
    : Either.left(new InvalidContestTransition({ from: c.status, to: "finished" }))
