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
          benchvm: { ...HEALTHY_INVENTORY.benchvm, memoryBytes: 4 * 1024 * 1024 * 1024, status: "stopped" }
        }
      })
      const h = yield* handler
      const outcome = yield* h.run(stepOf("memory_check"))
      expect(outcome.status).toBe("blocked")
    })
  )

  // 競技モード中 (benchvm が既に running で RAM を使っている) に Overview の「競技モード
  // 切替」が押し直されても、benchvm を起動する分の空きを要求して blocked にしない。blocked
  // は global lock を握ったままになり、cancel UI が無いので prepare / start まで止まる。
  it.effect("競技モード中に押し直しても空きメモリによらず全 step が何も変更せず succeeded", () =>
    Effect.gen(function* () {
      const { handler, proxmox } = buildHandler({
        infrastructureInventory: { ...HEALTHY_INVENTORY, nodeFreeMemBytes: 1 * 1024 * 1024 * 1024 }
      })
      const h = yield* handler
      for (const key of ENTER_CONTEST_MODE_STEP_KEYS) {
        expect(yield* h.run(stepOf(key))).toMatchObject({ status: "succeeded" })
      }
      const state = yield* proxmox.getState
      expect([state.shutdownRequests, state.startedVmids, state.onBootByVmid]).toEqual([[], [], {}])
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

// 2026-10-01 本番障害: inventory の onBoot が実値によらず false に畳まれていた
// ため、set_devvm_onboot_0 が「already 0」とスキップし devvm の onboot=1 が
// 残った(eevee 再起動で devvm と benchvm が両方自動起動しうる)。ショートカット
// は観測が確定している(Some)ときだけ。null = VM config が読めなかった(None)
// なら目標値を書く(setVmOnBoot は冪等な PUT)。
describe("enter_contest_mode の onboot step は観測が確定しているときだけスキップする", () => {
  it.effect.each([
    { observed: true, summary: "devvm.onBoot set to 0", written: { [DEVVM_VMID]: false } },
    { observed: null, summary: "devvm.onBoot set to 0", written: { [DEVVM_VMID]: false } },
    { observed: false, summary: "devvm.onBoot already 0", written: {} }
  ])("set_devvm_onboot_0: devvm.onBoot=$observed → $summary", ({ observed, summary, written }) =>
    Effect.gen(function* () {
      const { handler, proxmox } = buildHandler({
        infrastructureInventory: {
          ...HEALTHY_INVENTORY,
          devvm: { ...HEALTHY_INVENTORY.devvm, onBoot: observed }
        }
      })
      const outcome = yield* (yield* handler).run(stepOf("set_devvm_onboot_0"))
      expect(outcome).toEqual({ status: "succeeded", summary })
      expect((yield* proxmox.getState).onBootByVmid).toEqual(written)
    })
  )

  it.effect.each([
    { observed: false, summary: "benchvm.onBoot set to 1", written: { [BENCHVM_VMID]: true } },
    { observed: null, summary: "benchvm.onBoot set to 1", written: { [BENCHVM_VMID]: true } },
    { observed: true, summary: "benchvm.onBoot already 1", written: {} }
  ])("set_benchvm_onboot_1: benchvm.onBoot=$observed → $summary", ({ observed, summary, written }) =>
    Effect.gen(function* () {
      const { handler, proxmox } = buildHandler({
        infrastructureInventory: {
          ...HEALTHY_INVENTORY,
          benchvm: { ...HEALTHY_INVENTORY.benchvm, onBoot: observed }
        }
      })
      const outcome = yield* (yield* handler).run(stepOf("set_benchvm_onboot_1"))
      expect(outcome).toEqual({ status: "succeeded", summary })
      expect((yield* proxmox.getState).onBootByVmid).toEqual(written)
    })
  )
})

// 実機 eevee の VMID mapping (9200=benchvm / 9300=devvm) を取り違えた状態で
// mode transition を走らせると「devvm を止めるつもりで benchvm を止める」
// 事故になる (production を壊した実バグ)。eevee-mode.sh と同じ「名前が正」の
// 思想で、observed name が期待値と一致しない限り power 操作を一切発行しない。
describe("VMID mapping の fail-closed 検証", () => {
  // 実バグの形: inventory が返した 2 VM の名前が入れ替わっている。
  const SWAPPED_INVENTORY = {
    ...HEALTHY_INVENTORY,
    devvm: { ...HEALTHY_INVENTORY.devvm, name: "benchvm", status: "running" as const, onBoot: true },
    benchvm: { ...HEALTHY_INVENTORY.benchvm, name: "devvm", status: "stopped" as const, onBoot: false }
  }

  it.effect("observed name が期待値と一致しない場合、全 step が blocked で power 操作を発行しない", () =>
    Effect.gen(function* () {
      const { handler, proxmox } = buildHandler({ infrastructureInventory: SWAPPED_INVENTORY })
      const h = yield* handler
      for (const key of ENTER_CONTEST_MODE_STEP_KEYS) {
        const outcome = yield* h.run(stepOf(key))
        expect(outcome.status).toBe("blocked")
        expect(outcome.summary).toBe(
          `VMID mapping mismatch: VM ${DEVVM_VMID} is named 'benchvm', expected 'devvm'; ` +
            "verify /vms mapping before any power operation"
        )
      }
      const state = yield* proxmox.getState
      // power / config 操作は 1 件も出ない (retry ではなく operator 判断待ち)。
      expect(state.shutdownRequests).toEqual([])
      expect(state.startedVmids).toEqual([])
      expect(state.onBootByVmid).toEqual({})
      expect(state.forceStopRequests).toEqual([])
    })
  )

  it.effect("benchvm 側だけ名前がズレていても blocked (片方の mismatch で mapping 全体を疑う)", () =>
    Effect.gen(function* () {
      const { handler, proxmox } = buildHandler({
        infrastructureInventory: {
          ...HEALTHY_INVENTORY,
          benchvm: { ...HEALTHY_INVENTORY.benchvm, name: "vaporeon" }
        }
      })
      const h = yield* handler
      const outcome = yield* h.run(stepOf("start_benchvm"))
      expect(outcome.status).toBe("blocked")
      expect(outcome.summary).toBe(
        `VMID mapping mismatch: VM ${BENCHVM_VMID} is named 'vaporeon', expected 'benchvm'; ` +
          "verify /vms mapping before any power operation"
      )
      const state = yield* proxmox.getState
      expect(state.startedVmids).toEqual([])
    })
  )

  it.effect("名前が期待どおりなら従来の step 挙動 (power 操作の発行) を維持する", () =>
    Effect.gen(function* () {
      const { handler, proxmox } = buildHandler({
        infrastructureInventory: {
          ...HEALTHY_INVENTORY,
          devvm: { ...HEALTHY_INVENTORY.devvm, status: "running", onBoot: true },
          benchvm: { ...HEALTHY_INVENTORY.benchvm, status: "stopped", onBoot: false }
        }
      })
      const h = yield* handler
      expect((yield* h.run(stepOf("set_devvm_onboot_0"))).status).toBe("succeeded")
      expect((yield* h.run(stepOf("shutdown_devvm"))).status).toBe("succeeded")
      expect((yield* h.run(stepOf("set_benchvm_onboot_1"))).status).toBe("succeeded")
      expect((yield* h.run(stepOf("start_benchvm"))).status).toBe("succeeded")
      const state = yield* proxmox.getState
      // 実機 mapping: 停止するのは devvm=9300、起動するのは benchvm=9200。
      expect(state.shutdownRequests).toEqual([DEVVM_VMID])
      expect(state.startedVmids).toEqual([BENCHVM_VMID])
      expect(state.onBootByVmid).toEqual({ [DEVVM_VMID]: false, [BENCHVM_VMID]: true })
    })
  )
})
