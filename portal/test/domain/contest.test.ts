import { Either } from "effect"
import { describe, expect, it } from "vitest"
import { Contest, finishContest, startContest } from "../../src/domain/contest.js"
import { InvalidContestTransition } from "../../src/domain/errors.js"
import { ContestId } from "../../src/domain/ids.js"

const contestId = ContestId.make("11111111-1111-1111-1111-111111111111")

const makeContest = (status: Contest["status"]) =>
  new Contest({ id: contestId, name: "INUCON", problemKey: "problem-1", status })

describe("startContest / finishContest", () => {
  it("preparing → start → running → finish → finished と遷移できる", () => {
    const started = startContest(makeContest("preparing"))
    expect(Either.isRight(started)).toBe(true)
    if (!Either.isRight(started)) return
    expect(started.right.status).toBe("running")

    const finished = finishContest(started.right)
    expect(Either.isRight(finished)).toBe(true)
    if (!Either.isRight(finished)) return
    expect(finished.right.status).toBe("finished")
  })

  it("running から startContest すると InvalidContestTransition", () => {
    const result = startContest(makeContest("running"))
    expect(result).toStrictEqual(Either.left(new InvalidContestTransition({ from: "running", to: "running" })))
  })

  it("preparing から finishContest すると InvalidContestTransition", () => {
    const result = finishContest(makeContest("preparing"))
    expect(result).toStrictEqual(
      Either.left(new InvalidContestTransition({ from: "preparing", to: "finished" }))
    )
  })
})
