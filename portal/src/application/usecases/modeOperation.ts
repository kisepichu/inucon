import { Effect, Option } from "effect"
import { InvalidContestTransition } from "../../domain/errors.js"
import type { ContestId, UserId } from "../../domain/ids.js"
import { BENCHVM_VM_NAME, BENCHVM_VMID, DEVVM_VM_NAME, DEVVM_VMID, modeVmIdentityMismatch } from "../../domain/modeVmIds.js"
import type { Operation } from "../../domain/operation.js"
import { ContestNotFound } from "../errors.js"
import type { OperationHandler } from "../ports.js"
import { ContestRepo, ModeTransitionTimeout, OperationExecutionError, OperationInProgress, OperationRepo, ProxmoxPort, RepoError } from "../ports.js"
import type { StepOutcome } from "./operations.js"

// Task 8: enter_contest_mode Operation の step handler。
//
// enter_contest_mode は「devvm (9300) を graceful shutdown → 空 RAM を確認 →
// benchvm (9200) を起動」する。force stop は絶対に呼ばない。60 秒 guest
// shutdown が timeout に達したら ModeTransitionTimeout として blocked に落とし、
// operator 判断待ちにする。
//
// 各 step は開始前に必ず provider inventory を再観測し、
// - devvm が既に stopped、または benchvm が既に running の状態で対応する
//   step が呼ばれた場合は冪等成功として扱う。
// - memory_check は post-shutdown MemAvailable + devvm が保持していた RAM
//   の合計が benchvm 要求 + 1 GiB reserve を満たすかを見る(spec §mode)。
// - power 操作を出す前に、観測した devvm / benchvm の name が期待値と一致
//   することを必ず確かめる。不一致なら blocked(下記 fail-closed ガード)。
//
// return_normal_mode (Task 12) は逆順の別 Operation として実装する — この
// handler は「入る側」だけを担当する。

// review round 3 finding 3: DEVVM_VMID / BENCHVM_VMID の single source of
// truth は domain/modeVmIds.ts。application 層はここから re-export し、
// infra 層(proxmox/client.ts)も同じ domain module を読む(hexagonal 依存
// 方向を維持: app → domain / infra → domain)。step handler 本体は
// inv.devvm.vmid / inv.benchvm.vmid を使うので、この export は
// テスト便宜のみ(実運用の分岐は行わない)。
export { BENCHVM_VMID, DEVVM_VMID } from "../../domain/modeVmIds.js"

// 1 GiB host reserve(readiness の memory_check と同じ根拠)。
const HOST_MEMORY_RESERVE_BYTES = 1 * 1024 * 1024 * 1024

// spec で明示された 60 秒 graceful timeout。
const MODE_SHUTDOWN_TIMEOUT_MILLIS = 60_000
const MODE_START_TIMEOUT_MILLIS = 60_000

export const ENTER_CONTEST_MODE_STEP_KEYS = [
  "set_devvm_onboot_0",
  "shutdown_devvm",
  "wait_devvm_stopped",
  "memory_check",
  "set_benchvm_onboot_1",
  "start_benchvm",
  "verify_benchvm_running"
] as const
export type EnterContestModeStepKey = (typeof ENTER_CONTEST_MODE_STEP_KEYS)[number]

const succeeded = (summary: string): StepOutcome => ({ status: "succeeded", summary })
const blocked = (summary: string): StepOutcome => ({ status: "blocked", summary })

// Task 8: makeEnterContestModeHandler は OperationHandler を Effect で組み立てる
// factory。実 provider Layer(ProxmoxPort)は呼び出し側(main.ts の
// OperationHandlerRegistryLive)が provide する。テストは in-memory ProxmoxPort
// で直接この handler を run する(reconciliation と同じ形)。
export const makeEnterContestModeHandler: Effect.Effect<OperationHandler, never, ProxmoxPort> =
  Effect.gen(function* () {
    const px = yield* ProxmoxPort

    const runStep = (step: { readonly stepKey: string }): Effect.Effect<StepOutcome, OperationExecutionError> =>
      Effect.gen(function* () {
        // 毎 step 開始前に inventory を再観測する(spec §mode:
        // "re-observe status before every step")。
        const inv = yield* px.getInfrastructureInventory

        // inventory の各フィールドは独立に観測可能/不能(ports.ts
        // ProxmoxInfrastructureInventory 参照)。devvm / benchvm が観測
        // できない状態で power 操作を出すのは identity 検証を飛ばすのと同義
        // なので、fail-closed に blocked へ落とす(retry しない)。
        const devvm = Option.getOrNull(inv.devvm)
        const benchvm = Option.getOrNull(inv.benchvm)
        if (devvm === null || benchvm === null) {
          return blocked(
            "devvm/benchvm are not observable in the Proxmox inventory; " +
              "verify the mode credential ACL and /vms mapping before any power operation"
          )
        }

        // fail-closed な VMID mapping 検証。VMID 決め打ちだけで power 操作を出すと
        // renumbering / 取り違えで「devvm を止めるつもりで benchvm を止める」
        // 事故になる(実際に DEVVM_VMID / BENCHVM_VMID が実機と逆に定義されて
        // いた)。eevee-mode.sh と同じ「名前が正」の思想で、observed name が
        // 期待値と一致しない限り setVmOnBoot / shutdownVm / startVm を一切
        // 発行せず blocked に落とす。retry はしない — operator が Proxmox の
        // /vms mapping を直すまで進めない(force stop 禁止と同格の安全弁)。
        const identityMismatch = modeVmIdentityMismatch({ devvm, benchvm })
        if (identityMismatch !== null) return blocked(identityMismatch)

        switch (step.stepKey) {
          // onboot の冪等ショートカットは観測が確定している(Some)ときだけ。None
          // (VM config が読めなかった)を「already」とみなしてスキップすると、
          // devvm の onboot=1 が残ったまま benchvm も onboot=1 になり、eevee
          // 再起動で両方が自動起動しうる(2026-10-01 本番障害と同じ結果)。
          // 未観測なら目標値を書く(setVmOnBoot は冪等な config 更新)。
          case "set_devvm_onboot_0": {
            if (Option.contains(devvm.onBoot, false)) {
              return succeeded("devvm.onBoot already 0")
            }
            yield* px.setVmOnBoot(devvm.vmid, false)
            return succeeded("devvm.onBoot set to 0")
          }
          case "shutdown_devvm": {
            if (devvm.status === "stopped") {
              return succeeded("devvm already stopped")
            }
            yield* px.shutdownVm(devvm.vmid)
            return succeeded("devvm guest shutdown issued")
          }
          case "wait_devvm_stopped": {
            if (devvm.status === "stopped") {
              return succeeded("devvm already stopped")
            }
            const result = yield* Effect.either(
              px.waitForVmStatus(devvm.vmid, "stopped", MODE_SHUTDOWN_TIMEOUT_MILLIS)
            )
            if (result._tag === "Right") return succeeded("devvm reached stopped")
            if (result.left instanceof ModeTransitionTimeout) {
              // spec: "return blocked with the exact recovery command but do not run it"。
              return blocked(
                `devvm guest shutdown did not complete within ${MODE_SHUTDOWN_TIMEOUT_MILLIS}ms; ` +
                  `verify guest agent then run 'qm shutdown ${devvm.vmid}' manually (do not force stop)`
              )
            }
            return yield* Effect.fail(new OperationExecutionError({ cause: result.left }))
          }
          case "memory_check": {
            // benchvm が既に running なら起動用の空きは要らない(競技モード中の押し直し)。
            // ここで空きを要求すると benchvm / team VM が使っている分だけ足りずに blocked
            // になり、global lock を握ったまま prepare / start を止める。
            if (benchvm.status === "running") {
              return succeeded("benchvm already running")
            }
            // post-shutdown MemAvailable = 現時点の free + devvm 停止で解放される RAM。
            // devvm が既に stopped ならその分は加算しない(release 済み)。
            const nodeFreeMemBytes = Option.getOrNull(inv.nodeFreeMemBytes)
            if (nodeFreeMemBytes === null) {
              return blocked("node free memory is not observable in the Proxmox inventory; cannot verify headroom")
            }
            const devvmReleasable = devvm.status === "running" ? devvm.memoryBytes : 0
            const projected = nodeFreeMemBytes + devvmReleasable
            const required = benchvm.memoryBytes + HOST_MEMORY_RESERVE_BYTES
            return projected >= required
              ? succeeded(`post-shutdown MemAvailable ${projected}B ≥ benchvm(${benchvm.memoryBytes}B) + reserve(${HOST_MEMORY_RESERVE_BYTES}B)`)
              : blocked(
                  `post-shutdown MemAvailable ${projected}B < benchvm(${benchvm.memoryBytes}B) + reserve(${HOST_MEMORY_RESERVE_BYTES}B); ` +
                    "check other workloads on the node before retrying"
                )
          }
          case "set_benchvm_onboot_1": {
            if (Option.contains(benchvm.onBoot, true)) {
              return succeeded("benchvm.onBoot already 1")
            }
            yield* px.setVmOnBoot(benchvm.vmid, true)
            return succeeded("benchvm.onBoot set to 1")
          }
          case "start_benchvm": {
            if (benchvm.status === "running") {
              return succeeded("benchvm already running")
            }
            yield* px.startVm(benchvm.vmid)
            return succeeded("benchvm start issued")
          }
          case "verify_benchvm_running": {
            if (benchvm.status === "running") {
              return succeeded("benchvm already running")
            }
            const result = yield* Effect.either(
              px.waitForVmStatus(benchvm.vmid, "running", MODE_START_TIMEOUT_MILLIS)
            )
            if (result._tag === "Right") return succeeded("benchvm reached running")
            if (result.left instanceof ModeTransitionTimeout) {
              return blocked(
                `benchvm did not reach running within ${MODE_START_TIMEOUT_MILLIS}ms; ` +
                  `verify manually with 'qm start ${benchvm.vmid}' and inspect boot logs`
              )
            }
            return yield* Effect.fail(new OperationExecutionError({ cause: result.left }))
          }
          default:
            return blocked(`unknown enter_contest_mode step key: ${step.stepKey}`)
        }
      }).pipe(
        Effect.catchTag("ProxmoxError", (cause) => Effect.fail(new OperationExecutionError({ cause })))
      )

    return { run: runStep }
  })

// enter_contest_mode が触る VM。handler は inventory の devvm / benchvm (proxmox
// client が DEVVM_VMID / BENCHVM_VMID の config + qemu 一覧から解決し、power 操作の
// 前に期待名と突き合わせる) に対して power 操作を出すので、確認画面に出す対象は
// この定数で正確に表せる。Admin Web は GET /preparation-plan 経由でこれを受け取る。
export const ENTER_CONTEST_MODE_TARGETS = {
  // set_devvm_onboot_0 → shutdown_devvm (guest shutdown、force stop しない)
  shutdownVm: { vmid: DEVVM_VMID, name: DEVVM_VM_NAME },
  // set_benchvm_onboot_1 → start_benchvm
  startVm: { vmid: BENCHVM_VMID, name: BENCHVM_VM_NAME }
} as const

// enter_contest_mode Operation の step 一覧 (spec の順)。enterContestMode が使う。
// handler は inputSummary を読まず、毎 step inventory を再観測する。
export const buildEnterContestModeSteps = (): ReadonlyArray<{
  readonly stepKey: EnterContestModeStepKey
  readonly ordinal: number
  readonly inputSummary: string
  readonly continueOnError: false
}> =>
  ENTER_CONTEST_MODE_STEP_KEYS.map((key, i) => ({
    stepKey: key,
    ordinal: i,
    inputSummary: "{}",
    continueOnError: false
  }))

export type EnterContestModeError = RepoError | ContestNotFound | InvalidContestTransition | OperationInProgress

// spec §3「preparing と競技モード」: operator が Admin Web で明示確認したときだけ
// enter_contest_mode Operation を積む。preparing 以外は拒否する (draft は readiness
// gate を通っておらず、running 以降は benchvm 経由の参加者経路を前提にしている)。
// 既に競技モードでも拒否しない — 各 step が観測状態で冪等成功する。global lock
// (unfinished Operation 1 本) は OperationRepo.enqueue が OperationInProgress で返す。
export const enterContestMode = (args: {
  readonly contestId: ContestId
  readonly actorUserId: UserId
}): Effect.Effect<Operation, EnterContestModeError, ContestRepo | OperationRepo> =>
  Effect.gen(function* () {
    const found = yield* (yield* ContestRepo).findById(args.contestId)
    if (Option.isNone(found)) {
      return yield* Effect.fail(new ContestNotFound())
    }
    const contest = found.value
    if (contest.status !== "preparing") {
      return yield* Effect.fail(new InvalidContestTransition({ from: contest.status, to: "preparing" }))
    }
    return yield* (yield* OperationRepo).enqueue({
      contestId: contest.id,
      kind: "enter_contest_mode",
      actor: { kind: "admin", userId: args.actorUserId },
      planDigest: `enter_contest_mode:c${contest.id}:r${contest.revision}`,
      contestRevision: contest.revision,
      steps: buildEnterContestModeSteps()
    })
  })
