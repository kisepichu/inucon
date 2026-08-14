import { Either, Option } from "effect"
import { describe, expect, it } from "vitest"
import {
  BenchJob,
  cancelJob,
  checkEnqueueAllowed,
  failJob,
  finishJob,
  isTimedOut,
  newJob,
  recordProgress,
  startJob
} from "../../src/domain/benchJob.js"
import { CannotCancelRunning, ContestNotRunning, InvalidJobTransition, TargetIpOutOfSubnet } from "../../src/domain/errors.js"
import { BenchJobId, ContestId, TeamId } from "../../src/domain/ids.js"
import { makeContest } from "../support/factories.js"

const teamId = TeamId.make("22222222-2222-2222-2222-222222222222")
const jobId = BenchJobId.make("33333333-3333-3333-3333-333333333333")
const contestId = ContestId.make("44444444-4444-4444-4444-444444444444")


const baseEnqueueArgs = {
  contest: makeContest({ status: "running" }),
  purpose: "competition" as const,
  teamId,
  teamNumber: 1,
  targetIp: "10.100.1.11"
}

describe("checkEnqueueAllowed", () => {
  it("contest が preparing なら ContestNotRunning", () => {
    const result = checkEnqueueAllowed({ ...baseEnqueueArgs, contest: makeContest({ status: "preparing" }) })
    expect(result).toStrictEqual(Either.left(new ContestNotRunning({ status: "preparing" })))
  })

  it("targetIp がチームのサブネット外なら TargetIpOutOfSubnet", () => {
    const result = checkEnqueueAllowed({ ...baseEnqueueArgs, targetIp: "10.100.2.11" })
    expect(result).toStrictEqual(
      Either.left(new TargetIpOutOfSubnet({ ip: "10.100.2.11", teamNumber: 1 }))
    )
  })

  it("すべて満たせば right", () => {
    expect(checkEnqueueAllowed(baseEnqueueArgs)).toStrictEqual(Either.right(undefined))
  })
})

const makeQueuedJob = () =>
  newJob({ id: jobId, contestId, teamId, targetIp: "10.100.1.11", targetPort: 8080, purpose: "competition", now: 1000 })

describe("startJob", () => {
  it("queued → running に成功する(startedAt/lastProgressAt = now)", () => {
    const result = startJob(makeQueuedJob(), 2000)
    expect(Either.isRight(result)).toBe(true)
    if (!Either.isRight(result)) return
    expect(result.right.status).toBe("running")
    expect(result.right.startedAt).toStrictEqual(Option.some(2000))
    expect(result.right.lastProgressAt).toStrictEqual(Option.some(2000))
  })

  it("running から startJob すると left", () => {
    const running = startJob(makeQueuedJob(), 2000)
    if (!Either.isRight(running)) throw new Error("setup failed")
    expect(Either.isLeft(startJob(running.right, 3000))).toBe(true)
  })
})

describe("recordProgress", () => {
  it("running なら lastProgressAt を更新する", () => {
    const running = startJob(makeQueuedJob(), 2000)
    if (!Either.isRight(running)) throw new Error("setup failed")
    const result = recordProgress(running.right, 2500)
    expect(Either.isRight(result)).toBe(true)
    if (!Either.isRight(result)) return
    expect(result.right.lastProgressAt).toStrictEqual(Option.some(2500))
  })

  it("queued なら left(InvalidJobTransition)", () => {
    const result = recordProgress(makeQueuedJob(), 2000)
    expect(result).toStrictEqual(
      Either.left(new InvalidJobTransition({ jobId, from: "queued", action: "recordProgress" }))
    )
  })
})

describe("finishJob / failJob", () => {
  it("finishJob は running からのみ成功する", () => {
    expect(Either.isLeft(finishJob(makeQueuedJob(), { score: 1, passed: true }, 1000))).toBe(true)

    const running = startJob(makeQueuedJob(), 2000)
    if (!Either.isRight(running)) throw new Error("setup failed")
    const result = finishJob(running.right, { score: 100, passed: true }, 3000)
    expect(Either.isRight(result)).toBe(true)
    if (!Either.isRight(result)) return
    expect(result.right.status).toBe("finished")
    expect(result.right.score).toStrictEqual(Option.some(100))
    expect(result.right.passed).toStrictEqual(Option.some(true))
    expect(result.right.finishedAt).toStrictEqual(Option.some(3000))
  })

  it("failJob は running からのみ成功する", () => {
    expect(Either.isLeft(failJob(makeQueuedJob(), "boom", 1000))).toBe(true)

    const running = startJob(makeQueuedJob(), 2000)
    if (!Either.isRight(running)) throw new Error("setup failed")
    const result = failJob(running.right, "boom", 3000)
    expect(Either.isRight(result)).toBe(true)
    if (!Either.isRight(result)) return
    expect(result.right.status).toBe("failed")
    expect(result.right.errorMessage).toStrictEqual(Option.some("boom"))
    expect(result.right.finishedAt).toStrictEqual(Option.some(3000))
  })
})

describe("cancelJob", () => {
  it("queued → canceled に成功する", () => {
    const result = cancelJob(makeQueuedJob())
    expect(Either.isRight(result)).toBe(true)
    if (!Either.isRight(result)) return
    expect(result.right.status).toBe("canceled")
  })

  it("running は CannotCancelRunning", () => {
    const running = startJob(makeQueuedJob(), 2000)
    if (!Either.isRight(running)) throw new Error("setup failed")
    expect(cancelJob(running.right)).toStrictEqual(Either.left(new CannotCancelRunning({ jobId })))
  })

  it("finished は left(InvalidJobTransition)", () => {
    const running = startJob(makeQueuedJob(), 2000)
    if (!Either.isRight(running)) throw new Error("setup failed")
    const finished = finishJob(running.right, { score: 1, passed: true }, 3000)
    if (!Either.isRight(finished)) throw new Error("setup failed")
    const result = cancelJob(finished.right)
    expect(Either.isLeft(result)).toBe(true)
    if (!Either.isLeft(result)) return
    expect(result.left).toBeInstanceOf(InvalidJobTransition)
  })
})

describe("isTimedOut", () => {
  it("running かつ進捗途絶が timeout を超えたら true (lastProgressAt=0, now=600001, timeout=600000)", () => {
    const job = new BenchJob({ ...makeQueuedJob(), status: "running", lastProgressAt: Option.some(0) })
    expect(isTimedOut(job, 600_001, 600_000)).toBe(true)
  })

  it("ちょうど timeout 未満なら false (now=599999)", () => {
    const job = new BenchJob({ ...makeQueuedJob(), status: "running", lastProgressAt: Option.some(0) })
    expect(isTimedOut(job, 599_999, 600_000)).toBe(false)
  })

  it("queued なら常に false", () => {
    expect(isTimedOut(makeQueuedJob(), 10_000_000, 600_000)).toBe(false)
  })
})
