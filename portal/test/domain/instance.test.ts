import { Either, Option } from "effect"
import { describe, expect, it } from "vitest"
import {
  addStep,
  beginDeleting,
  Instance,
  ipFor,
  markDeleted,
  markFailed,
  markProvisioned,
  newInstance,
  vmidFor
} from "../../src/domain/instance.js"
import { InvalidInstanceTransition } from "../../src/domain/errors.js"
import { ContestId, InstanceId, TeamId } from "../../src/domain/ids.js"

const instanceId = InstanceId.make("11111111-1111-1111-1111-111111111111")
const teamId = TeamId.make("22222222-2222-2222-2222-222222222222")
const contestId = ContestId.make("33333333-3333-3333-3333-333333333333")

const makeInstance = (status: Instance["status"], progress: Instance["progress"] = []) =>
  new Instance({
    id: instanceId,
    contestId,
    teamId,
    index: 1,
    vmid: 1101,
    privateIp: "10.100.1.11",
    status,
    progress,
    errorMessage: Option.none(),
    createdAt: 1000,
    updatedAt: 1000
  })

describe("vmidFor / ipFor", () => {
  it("vmidFor(1, 1) === 1101(実績: team1-1)", () => {
    expect(vmidFor(1, 1)).toBe(1101)
  })

  it("vmidFor(2, 3) === 1203", () => {
    expect(vmidFor(2, 3)).toBe(1203)
  })

  it('ipFor(1, 1) === "10.100.1.11"', () => {
    expect(ipFor(1, 1)).toBe("10.100.1.11")
  })
})

describe("newInstance", () => {
  it("status=creating, progress=[], vmid/ip 計算済みで生成する", () => {
    const instance = newInstance({ id: instanceId, contestId, teamId, index: 1, teamNumber: 1, now: 1000 })
    expect(instance.status).toBe("creating")
    expect(instance.vmid).toBe(1101)
    expect(instance.privateIp).toBe("10.100.1.11")
    expect(instance.progress).toStrictEqual([])
    expect(instance.errorMessage).toStrictEqual(Option.none())
    expect(instance.createdAt).toBe(1000)
    expect(instance.updatedAt).toBe(1000)
  })
})

describe("addStep", () => {
  it("progress へ追加し updatedAt を更新する", () => {
    const instance = makeInstance("creating")
    const updated = addStep(instance, "clone_done", 2000)
    expect(updated.progress).toStrictEqual(["clone_done"])
    expect(updated.updatedAt).toBe(2000)
  })

  it("同じ step を2回addしても冪等(重複しない、2回目は不変)", () => {
    const instance = makeInstance("creating")
    const once = addStep(instance, "clone_done", 2000)
    const twice = addStep(once, "clone_done", 3000)
    expect(twice.progress).toStrictEqual(["clone_done"])
    expect(twice).toStrictEqual(once)
  })

  it("複数 step を積める", () => {
    const instance = makeInstance("creating")
    const updated = addStep(addStep(instance, "clone_done", 2000), "configured", 3000)
    expect(updated.progress).toStrictEqual(["clone_done", "configured"])
  })
})

describe("markProvisioned", () => {
  it("creating → running", () => {
    const result = markProvisioned(makeInstance("creating"), 2000)
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.status).toBe("running")
      expect(result.right.updatedAt).toBe(2000)
    }
  })

  for (const from of ["running", "deleting", "deleted", "failed"] as const) {
    it(`${from} からは InvalidInstanceTransition`, () => {
      const result = markProvisioned(makeInstance(from), 2000)
      expect(result).toStrictEqual(
        Either.left(new InvalidInstanceTransition({ instanceId, from, to: "running" }))
      )
    })
  }
})

describe("beginDeleting", () => {
  for (const from of ["running", "failed"] as const) {
    it(`${from} → deleting`, () => {
      const result = beginDeleting(makeInstance(from), 2000)
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.status).toBe("deleting")
        expect(result.right.updatedAt).toBe(2000)
      }
    })
  }

  for (const from of ["creating", "deleting", "deleted"] as const) {
    it(`${from} からは InvalidInstanceTransition`, () => {
      const result = beginDeleting(makeInstance(from), 2000)
      expect(result).toStrictEqual(
        Either.left(new InvalidInstanceTransition({ instanceId, from, to: "deleting" }))
      )
    })
  }
})

describe("markDeleted", () => {
  it("deleting → deleted", () => {
    const result = markDeleted(makeInstance("deleting"), 2000)
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.status).toBe("deleted")
      expect(result.right.updatedAt).toBe(2000)
    }
  })

  for (const from of ["creating", "running", "deleted", "failed"] as const) {
    it(`${from} からは InvalidInstanceTransition`, () => {
      const result = markDeleted(makeInstance(from), 2000)
      expect(result).toStrictEqual(
        Either.left(new InvalidInstanceTransition({ instanceId, from, to: "deleted" }))
      )
    })
  }
})

describe("markFailed", () => {
  for (const from of ["creating", "deleting"] as const) {
    it(`${from} → failed(errorMessage が設定される)`, () => {
      const failed = markFailed(makeInstance(from), "boom", 2000)
      expect(failed.status).toBe("failed")
      expect(failed.errorMessage).toStrictEqual(Option.some("boom"))
      expect(failed.updatedAt).toBe(2000)
    })
  }
})
