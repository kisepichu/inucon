import { it } from "@effect/vitest"
import { Effect, Exit, Layer, Option } from "effect"
import { describe, expect } from "vitest"
import {
  ModeTransitionTimeout,
  ProxmoxError,
  ProxmoxPort
} from "../../src/application/ports.js"
import {
  ENTER_CONTEST_MODE_STEP_KEYS,
  makeEnterContestModeHandler
} from "../../src/application/usecases/modeOperation.js"
import {
  BENCHVM_VMID,
  DEVVM_VMID
} from "../../src/application/usecases/modeOperation.js"
import { ContestId, OperationId, OperationStepId } from "../../src/domain/ids.js"
import { OperationStep } from "../../src/domain/operation.js"
import type { ProxmoxTestOptions } from "../support/inMemory.js"
import { makeProxmoxPortTest } from "../support/inMemory.js"

// Task 8 Step 1: enter_contest_mode Operation の step 順序と idempotence を
// 検証する。実 provider 呼び出しは in-memory ProxmoxPort でモックする
// (proxmox.test.ts 側で power primitive の HTTP 契約は別途検証する)。

const CONTEST_ID = ContestId.make("c-mode-1")
const OP_ID = OperationId.make("op-mode-1")

const stepOf = (key: string): OperationStep =>
  new OperationStep({
    id: OperationStepId.make(`s-${key}`),
    operationId: OP_ID,
    ordinal: 0,
    stepKey: key,
    status: "queued",
    attempt: 1,
    continueOnError: false,
    retryAt: Option.none(),
    leaseExpiresAt: Option.none(),
    inputSummary: JSON.stringify({ contestId: CONTEST_ID }),
    progressJson: "{}",
    resultSummary: Option.none(),
    sanitizedError: Option.none(),
    createdAt: 0,
    startedAt: Option.none(),
    finishedAt: Option.none()
  })

// 「全 step が succeeded を返す(idempotent success)」テスト用の post-mode
// inventory。devvm は既に stopped、benchvm は既に running(すべての step が
// 冪等 short-circuit する)。個別 step のテストは各自の必要な状態を上書きする。
const HEALTHY_INVENTORY = {
  nodeFreeMemBytes: 20_000_000_000,
  templateExists: true,
  devvm: { vmid: DEVVM_VMID, name: "devvm", status: "stopped" as const, memoryBytes: 8 * 1024 * 1024 * 1024, onBoot: false },
  benchvm: { vmid: BENCHVM_VMID, name: "benchvm", status: "running" as const, memoryBytes: 4 * 1024 * 1024 * 1024, onBoot: true },
  preparedTeamNumbers: [1, 2] as ReadonlyArray<number>,
  isolationServiceActive: true
}
const buildHandler = (opts: ProxmoxTestOptions = {}) => {
  const proxmox = makeProxmoxPortTest({
    ...opts,
    infrastructureInventory: opts.infrastructureInventory ?? HEALTHY_INVENTORY
  })
  return {
    proxmox,
    handler: makeEnterContestModeHandler.pipe(Effect.provide(proxmox.layer))
  }
}

describe("enter_contest_mode の step 一覧と順序", () => {
  it("スペックに定義された順序で step key を持つ", () => {
    expect([...ENTER_CONTEST_MODE_STEP_KEYS]).toEqual([
      "set_devvm_onboot_0",
      "shutdown_devvm",
      "wait_devvm_stopped",
      "memory_check",
      "set_benchvm_onboot_1",
      "start_benchvm",
      "verify_benchvm_running"
    ])
  })
})

describe("enter_contest_mode の handler", () => {
  it.effect("healthy な状態では全 step が succeeded を返す", () =>
    Effect.gen(function* () {
      const { handler } = buildHandler()
      const h = yield* handler
      for (const key of ENTER_CONTEST_MODE_STEP_KEYS) {
        const outcome = yield* h.run(stepOf(key))
        expect(outcome.status).toBe("succeeded")
      }
    })
  )

  it.effect("shutdown_devvm: devvm が既に stopped なら shutdown 呼び出しを skip して succeeded", () =>
    Effect.gen(function* () {
      const { handler, proxmox } = buildHandler({
        infrastructureInventory: {
          ...HEALTHY_INVENTORY,
          devvm: { ...HEALTHY_INVENTORY.devvm, status: "stopped" }
        }
      })
      const h = yield* handler
      const outcome = yield* h.run(stepOf("shutdown_devvm"))
      expect(outcome.status).toBe("succeeded")
      const state = yield* proxmox.getState
      expect(state.shutdownRequests).toEqual([])
    })
  )

  it.effect("start_benchvm: benchvm が既に running なら start 呼び出しを skip して succeeded", () =>
    Effect.gen(function* () {
      const { handler, proxmox } = buildHandler({
        infrastructureInventory: {
          ...HEALTHY_INVENTORY,
          benchvm: { ...HEALTHY_INVENTORY.benchvm, status: "running" }
        }
      })
      const h = yield* handler
      const outcome = yield* h.run(stepOf("start_benchvm"))
      expect(outcome.status).toBe("succeeded")
      const state = yield* proxmox.getState
      expect(state.startedVmids).toEqual([])
    })
  )

  it.effect("wait_devvm_stopped: timeout に達すれば blocked、force stop は呼ばない", () =>
    Effect.gen(function* () {
      const { handler, proxmox } = buildHandler({
        infrastructureInventory: {
          ...HEALTHY_INVENTORY,
          devvm: { ...HEALTHY_INVENTORY.devvm, status: "running" }
        },
        failWith: {
          waitForVmStatus: new ModeTransitionTimeout({ vmid: DEVVM_VMID, expected: "stopped", timeoutMillis: 60_000 })
        }
      })
      const h = yield* handler
      const outcome = yield* h.run(stepOf("wait_devvm_stopped"))
      expect(outcome.status).toBe("blocked")
      // recovery command は summary に含める、が生の Authorization/cause は含めない。
      expect(outcome.summary).toMatch(/devvm/i)
      const state = yield* proxmox.getState
      // force stop は一切呼ばない(mode transition の安全ガード)。
      expect(state.forceStopRequests ?? []).toEqual([])
    })
  )

  it.effect("memory_check: MemAvailable + devvm RAM が benchvm 要求 + 1GiB reserve に満たなければ blocked", () =>
    Effect.gen(function* () {
      const { handler } = buildHandler({
        infrastructureInventory: {
          ...HEALTHY_INVENTORY,
          nodeFreeMemBytes: 2 * 1024 * 1024 * 1024,
          devvm: { ...HEALTHY_INVENTORY.devvm, memoryBytes: 1 * 1024 * 1024 * 1024, status: "stopped" },
          benchvm: { ...HEALTHY_INVENTORY.benchvm, memoryBytes: 4 * 1024 * 1024 * 1024 }
        }
      })
      const h = yield* handler
      const outcome = yield* h.run(stepOf("memory_check"))
      expect(outcome.status).toBe("blocked")
    })
  )

  it.effect("re-observes provider before every step (毎 step 前に getInfrastructureInventory を叩き直す)", () =>
    Effect.gen(function* () {
      const { handler, proxmox } = buildHandler()
      const h = yield* handler
      yield* h.run(stepOf("set_devvm_onboot_0"))
      yield* h.run(stepOf("shutdown_devvm"))
      yield* h.run(stepOf("wait_devvm_stopped"))
      yield* h.run(stepOf("memory_check"))
      yield* h.run(stepOf("set_benchvm_onboot_1"))
      yield* h.run(stepOf("start_benchvm"))
      yield* h.run(stepOf("verify_benchvm_running"))
      const state = yield* proxmox.getState
      // step 数 (7) 分だけ inventory を観測する。
      expect((state.inventoryReads ?? 0) >= 7).toBe(true)
    })
  )

  it.effect("Proxmox 実 API が復旧不能なエラーを返した step は OperationExecutionError で fail する", () =>
    Effect.gen(function* () {
      const { handler } = buildHandler({
        infrastructureInventory: {
          ...HEALTHY_INVENTORY,
          devvm: { ...HEALTHY_INVENTORY.devvm, status: "running" }
        },
        failWith: {
          shutdownVm: new ProxmoxError({ cause: "network error" })
        }
      })
      const h = yield* handler
      const exit = yield* Effect.exit(h.run(stepOf("shutdown_devvm")))
      expect(Exit.isFailure(exit)).toBe(true)
    })
  )
})
