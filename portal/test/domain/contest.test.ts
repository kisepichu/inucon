import { Either, Option } from "effect"
import { describe, expect, it } from "vitest"
import {
  beginFinalization,
  beginPreparation,
  cancelContest,
  finishContest,
  startContest
} from "../../src/domain/contest.js"
import { InvalidContestSchedule, InvalidContestTransition } from "../../src/domain/errors.js"
import { makeContest } from "../support/factories.js"

describe("Contest lifecycle (multi-edition)", () => {
  it("draft -> preparing requires a complete ordered schedule", () => {
    const draft = makeContest({
      status: "draft",
      scheduledStartAt: Option.some(100),
      scheduledEndAt: Option.some(200),
      accessClosesAt: Option.some(200)
    })
    const ok = beginPreparation(draft)
    expect(Either.isRight(ok)).toBe(true)
    if (Either.isRight(ok)) {
      expect(ok.right.status).toBe("preparing")
      expect(ok.right.revision).toBe(draft.revision + 1)
    }

    const reversed = beginPreparation(
      makeContest({
        status: "draft",
        scheduledStartAt: Option.some(200),
        scheduledEndAt: Option.some(100),
        accessClosesAt: Option.some(200)
      })
    )
    expect(Either.isLeft(reversed)).toBe(true)
    if (Either.isLeft(reversed)) {
      expect(reversed.left).toBeInstanceOf(InvalidContestSchedule)
    }
  })

  it("draft -> preparing rejects unset schedule", () => {
    const res = beginPreparation(makeContest({ status: "draft" }))
    expect(res).toStrictEqual(Either.left(new InvalidContestSchedule({ reason: "missing_schedule" })))
  })

  it("draft -> preparing rejects accessClosesAt < scheduledEndAt", () => {
    const res = beginPreparation(
      makeContest({
        status: "draft",
        scheduledStartAt: Option.some(100),
        scheduledEndAt: Option.some(200),
        accessClosesAt: Option.some(150)
      })
    )
    expect(res).toStrictEqual(Either.left(new InvalidContestSchedule({ reason: "access_close_before_end" })))
  })

  it("draft -> preparing rejects cleanupAt < accessClosesAt", () => {
    const res = beginPreparation(
      makeContest({
        status: "draft",
        scheduledStartAt: Option.some(100),
        scheduledEndAt: Option.some(200),
        accessClosesAt: Option.some(300),
        cleanupAt: Option.some(250)
      })
    )
    expect(res).toStrictEqual(Either.left(new InvalidContestSchedule({ reason: "cleanup_before_access_close" })))
  })

  it("preparing -> running stamps startedAt and bumps revision", () => {
    const preparing = makeContest({ status: "preparing" })
    const started = startContest(preparing, 500)
    expect(Either.isRight(started)).toBe(true)
    if (Either.isRight(started)) {
      expect(started.right.status).toBe("running")
      expect(started.right.startedAt).toStrictEqual(Option.some(500))
      expect(started.right.revision).toBe(preparing.revision + 1)
    }
  })

  it("running -> finalizing -> finished records actual timestamps", () => {
    const running = makeContest({ status: "running" })
    const finalizing = Either.getOrThrow(beginFinalization(running, 300))
    expect(finalizing.status).toBe("finalizing")
    expect(finalizing.finalizingAt).toStrictEqual(Option.some(300))
    const finished = Either.getOrThrow(finishContest(finalizing, 400))
    expect(finished.status).toBe("finished")
    expect(finished.finishedAt).toStrictEqual(Option.some(400))
    expect(finished.revision).toBe(running.revision + 2)
  })

  it("startContest / beginFinalization / finishContest reject wrong source status", () => {
    expect(startContest(makeContest({ status: "running" }), 1)).toStrictEqual(
      Either.left(new InvalidContestTransition({ from: "running", to: "running" }))
    )
    expect(beginFinalization(makeContest({ status: "preparing" }), 1)).toStrictEqual(
      Either.left(new InvalidContestTransition({ from: "preparing", to: "finalizing" }))
    )
    expect(finishContest(makeContest({ status: "running" }), 1)).toStrictEqual(
      Either.left(new InvalidContestTransition({ from: "running", to: "finished" }))
    )
  })

  it("draft or preparing can be canceled with canceledAt stamp", () => {
    const draftCanceled = Either.getOrThrow(cancelContest(makeContest({ status: "draft" }), 700))
    expect(draftCanceled.status).toBe("canceled")
    expect(draftCanceled.canceledAt).toStrictEqual(Option.some(700))

    const preparingCanceled = Either.getOrThrow(cancelContest(makeContest({ status: "preparing" }), 800))
    expect(preparingCanceled.status).toBe("canceled")
    expect(preparingCanceled.canceledAt).toStrictEqual(Option.some(800))
  })

  it("running/finalizing/finished cannot be canceled", () => {
    for (const status of ["running", "finalizing", "finished"] as const) {
      const res = cancelContest(makeContest({ status }), 900)
      expect(res).toStrictEqual(Either.left(new InvalidContestTransition({ from: status, to: "canceled" })))
    }
  })
})
