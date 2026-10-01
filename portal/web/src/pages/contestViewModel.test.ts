import { describe, expect, it } from "vitest"
import type { Contest, ReadinessCheck, ReconciliationPlan } from "shared/schemas"
import {
  actionableEntries,
  adoptRequiredHostnames,
  computeContestActions,
  contestStatusLabel,
  ERROR_MESSAGES,
  groupReadinessByStatus,
  hasBlockingReadinessFailure,
  isOperationTerminal,
  messageForErrorTag,
  nextLiveEdition,
  operationKindLabel,
  operationalContest,
  operationStatusVariant
} from "./contestViewModel.ts"

// Task 13 Step 1 の TDD 対象。純粋な view-model 関数の挙動を DOM 非依存で
// 検証する。既存 API contract (shared/schemas) を型としてそのまま使い、
// runtime decode は行わない (ContestSetup と同じ方針)。

const baseContest = {
  id: "c-1",
  edition: 1,
  name: "INUCON",
  problemKey: "private-isu",
  problemRevision: "2026-08",
  templateVmid: 9100,
  status: "draft",
  instanceQuota: 3,
  scheduledStartAt: null,
  scheduledEndAt: null,
  accessClosesAt: null,
  cleanupAt: null,
  accessClosedAt: null,
  cleanupCompletedAt: null,
  startedAt: null,
  finalizingAt: null,
  finishedAt: null,
  canceledAt: null,
  revision: 1
} as unknown as Contest

describe("computeContestActions", () => {
  it("draft は edit / beginPrepare / cancelDraft のみ有効", () => {
    const a = computeContestActions({ ...baseContest, status: "draft" } as Contest)
    expect(a).toMatchObject({
      editDraft: true,
      beginPrepare: true,
      cancelDraft: true,
      startContest: false,
      immediateFinish: false,
      cleanup: false,
      returnNormal: false,
      rearchive: false
    })
  })

  it("preparing は startContest / cancelDraft / reconcile が有効", () => {
    const a = computeContestActions({ ...baseContest, status: "preparing" } as Contest)
    expect(a.startContest).toBe(true)
    expect(a.cancelDraft).toBe(true)
    expect(a.reconcile).toBe(true)
    expect(a.beginPrepare).toBe(false)
    expect(a.immediateFinish).toBe(false)
  })

  it("running は immediateFinish / reconcile が有効、cleanup / returnNormal は無効", () => {
    const a = computeContestActions({ ...baseContest, status: "running" } as Contest)
    expect(a.immediateFinish).toBe(true)
    expect(a.reconcile).toBe(true)
    expect(a.cleanup).toBe(false)
    expect(a.returnNormal).toBe(false)
    expect(a.startContest).toBe(false)
  })

  it("finished は cleanup / returnNormal / reconcile / rearchive のみ有効", () => {
    const a = computeContestActions({ ...baseContest, status: "finished" } as Contest)
    expect(a.cleanup).toBe(true)
    expect(a.returnNormal).toBe(true)
    expect(a.reconcile).toBe(true)
    expect(a.rearchive).toBe(true)
    expect(a.startContest).toBe(false)
    expect(a.immediateFinish).toBe(false)
    expect(a.beginPrepare).toBe(false)
  })

  it("canceled は cleanup / returnNormal のみ (rearchive は finished 限定)", () => {
    const a = computeContestActions({ ...baseContest, status: "canceled" } as Contest)
    expect(a.cleanup).toBe(true)
    expect(a.returnNormal).toBe(true)
    expect(a.rearchive).toBe(false)
    expect(a.startContest).toBe(false)
  })
})

describe("groupReadinessByStatus", () => {
  it("fail / warn / pass にバケット分けする (fail が空でも存在する)", () => {
    const checks: ReadonlyArray<ReadinessCheck> = [
      { key: "portal_db", status: "pass", summary: "ok" },
      { key: "template", status: "warn", summary: "estimated" },
      { key: "runner", status: "fail", summary: "stale heartbeat" },
      { key: "memory", status: "pass", summary: "ok" }
    ]
    const g = groupReadinessByStatus(checks)
    expect(g.fail.map((c) => c.key)).toEqual(["runner"])
    expect(g.warn.map((c) => c.key)).toEqual(["template"])
    expect(g.pass.map((c) => c.key)).toEqual(["portal_db", "memory"])
  })

  it("fail が 1 件でもあれば hasBlockingReadinessFailure が true", () => {
    const checks: ReadonlyArray<ReadinessCheck> = [
      { key: "a", status: "pass", summary: "ok" },
      { key: "b", status: "fail", summary: "x" }
    ]
    expect(hasBlockingReadinessFailure(checks)).toBe(true)
    expect(hasBlockingReadinessFailure([{ key: "a", status: "warn", summary: "ok" }])).toBe(false)
  })
})

describe("adoptRequiredHostnames / actionableEntries", () => {
  const plan: ReconciliationPlan = {
    contestId: "c-1" as unknown as ReconciliationPlan["contestId"],
    contestRevision: 1,
    planDigest: "d",
    generatedAt: 100,
    adoptHostnames: [],
    entries: [
      {
        hostname: "inucon-team1-1",
        classification: "in_sync",
        action: "noop",
        reason: "same",
        proxmoxVmid: 1101,
        cloudflareRouteCount: 1,
        cloudflareIngressCount: 1,
        cloudflareAppCount: 1,
        bindingIds: [],
        instanceId: null,
        cleanupTarget: true
      },
      {
        hostname: "inucon-team1-2",
        classification: "unmanaged_orphan",
        action: "blocked",
        reason: "no binding",
        proxmoxVmid: null,
        cloudflareRouteCount: 1,
        cloudflareIngressCount: 0,
        cloudflareAppCount: 1,
        bindingIds: [],
        instanceId: null,
        cleanupTarget: false
      },
      {
        hostname: "inucon-team2-1",
        classification: "managed_orphan",
        action: "cleanup",
        reason: "portal-owned",
        proxmoxVmid: 2101,
        cloudflareRouteCount: 0,
        cloudflareIngressCount: 0,
        cloudflareAppCount: 0,
        bindingIds: [],
        instanceId: null,
        cleanupTarget: true
      }
    ]
  } as unknown as ReconciliationPlan

  it("adoptRequiredHostnames は unmanaged_orphan だけを列挙", () => {
    expect(adoptRequiredHostnames(plan)).toEqual(["inucon-team1-2"])
  })

  it("actionableEntries は noop 以外を返す", () => {
    expect(actionableEntries(plan).map((e) => e.hostname)).toEqual([
      "inucon-team1-2",
      "inucon-team2-1"
    ])
  })
})

describe("isOperationTerminal", () => {
  it("succeeded / failed / canceled は terminal", () => {
    expect(isOperationTerminal("succeeded")).toBe(true)
    expect(isOperationTerminal("failed")).toBe(true)
    expect(isOperationTerminal("canceled")).toBe(true)
  })

  it("queued / running / blocked は non-terminal (blocked は operator 対応待ち)", () => {
    expect(isOperationTerminal("queued")).toBe(false)
    expect(isOperationTerminal("running")).toBe(false)
    expect(isOperationTerminal("blocked")).toBe(false)
  })
})

describe("operationStatusVariant", () => {
  it("blocked を専用 variant にする (running/success/error と分離)", () => {
    expect(operationStatusVariant("blocked")).toBe("blocked")
    expect(operationStatusVariant("running")).toBe("running")
    expect(operationStatusVariant("succeeded")).toBe("success")
    expect(operationStatusVariant("failed")).toBe("error")
    expect(operationStatusVariant("canceled")).toBe("error")
    expect(operationStatusVariant("queued")).toBe("pending")
  })
})

describe("messageForErrorTag", () => {
  it("既知の tag は日本語メッセージにマップ", () => {
    expect(messageForErrorTag("StaleReconciliationPlan")).toBe(
      "状態が変わりました。再診断してください"
    )
    expect(messageForErrorTag("ContestRevisionConflict")).toBe(
      "状態が変わりました。再診断してください"
    )
    expect(messageForErrorTag("AmbiguousReconciliation")).toBe(
      "unmanaged_orphan を adopt してください"
    )
  })

  it("未知の tag はそのまま返す", () => {
    expect(messageForErrorTag("XyzNonExistentTag")).toBe("XyzNonExistentTag")
  })

  it("生の credential / cause / email 語彙を含まない", () => {
    for (const message of Object.values(ERROR_MESSAGES)) {
      expect(message).not.toMatch(/@|bearer|token|password|CF_API_TOKEN/i)
    }
  })
})

describe("nextLiveEdition / operationalContest / labels", () => {
  it("nextLiveEdition は canceled を無視して live 最大 + 1", () => {
    expect(nextLiveEdition([])).toBe(1)
    expect(
      nextLiveEdition([
        { ...baseContest, id: "c1", edition: 1, status: "finished" } as Contest,
        { ...baseContest, id: "c2", edition: 3, status: "canceled" } as Contest
      ])
    ).toBe(2)
  })

  it("operationalContest は preparing/running/finalizing のうち最初", () => {
    expect(
      operationalContest([{ ...baseContest, status: "finished" } as Contest])
    ).toBeNull()
    const running = { ...baseContest, id: "c-run", status: "running" } as Contest
    expect(
      operationalContest([{ ...baseContest, status: "canceled" } as Contest, running])?.id
    ).toBe("c-run")
  })

  it("全 contest status に日本語ラベルがある", () => {
    for (const s of ["draft", "preparing", "running", "finalizing", "finished", "canceled"] as const) {
      expect(contestStatusLabel[s]).toBeTruthy()
    }
  })

  it("全 operation kind に日本語ラベルがある", () => {
    for (const k of [
      "reconcile",
      "enter_contest_mode",
      "prepare",
      "start",
      "finish",
      "revoke_access",
      "cleanup",
      "return_normal_mode",
      "backup"
    ] as const) {
      expect(operationKindLabel[k]).toBeTruthy()
    }
  })
})
