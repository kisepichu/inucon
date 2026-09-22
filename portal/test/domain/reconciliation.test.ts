import { Option } from "effect"
import { describe, expect, it } from "vitest"
import { InstanceId, ResourceBindingId, TeamId, ContestId } from "../../src/domain/ids.js"
import {
  classifyHostname,
  computePlanDigest,
  type HostnameDesired,
  type HostnameObservation,
  type ReconciliationEntry
} from "../../src/domain/reconciliation.js"

// Task 7 Step 1: 2026-08-13 legacy state fixture. reconciliation の分類器は
// (observation, desired, adopted) の 3 入力から 1 hostname あたり 1 分類を返す
// 純粋関数として設計する — provider inventory 側は Task 3 の filter
// (Proxmox `^inucon-team[0-9]+-[0-9]+$`) と CF の name prefix でここに渡す
// hostname を絞るため、無関係 / catch-all の record はそもそも入力に現れない。

const CONTEST = ContestId.make("c-2026-08-13")
const TEAM_1 = TeamId.make("t-1")
const INSTANCE_1_1 = InstanceId.make("i-1-1")
const BINDING_VM = ResourceBindingId.make("b-vm-1-1")
const BINDING_DNS = ResourceBindingId.make("b-dns-1-1")
const BINDING_ING = ResourceBindingId.make("b-ing-1-1")
const BINDING_APP = ResourceBindingId.make("b-app-1-1")

describe("classifyHostname", () => {
  it("team1-1: DB Instance running + Proxmox VM missing + CF present → missing + cleanup", () => {
    const observation: HostnameObservation = {
      hostname: "inucon-team1-1",
      proxmoxVm: Option.none(),
      cloudflareRouteCount: 1,
      cloudflareIngressCount: 1,
      cloudflareAppCount: 1
    }
    const desired: HostnameDesired = {
      hostname: "inucon-team1-1",
      contestId: CONTEST,
      teamId: Option.some(TEAM_1),
      instanceId: Option.some(INSTANCE_1_1),
      instanceStatus: Option.some("running"),
      cloudflareBindingIds: [BINDING_DNS, BINDING_ING, BINDING_APP],
      proxmoxBindingIds: [BINDING_VM]
    }
    const entry = classifyHostname({ observation, desired, adopted: false })
    expect(entry.classification).toBe("missing")
    expect(entry.action).toBe("cleanup")
    expect(entry.hostname).toBe("inucon-team1-1")
    expect(entry.proxmoxVmObserved).toBe(false)
    expect(entry.cloudflareRouteCount).toBe(1)
    expect(entry.cloudflareAppCount).toBe(1)
    // reason は sanitize 済み(email/token/host detail を含まない)
    expect(entry.reason).not.toMatch(/@/)
    expect(entry.reason).not.toMatch(/Bearer|PVEAPIToken/i)
  })

  it("team2-1: 未管理 legacy CF orphan は adopt 未指定なら unmanaged_orphan + blocked", () => {
    const observation: HostnameObservation = {
      hostname: "inucon-team2-1",
      proxmoxVm: Option.none(),
      cloudflareRouteCount: 1,
      cloudflareIngressCount: 1,
      cloudflareAppCount: 1
    }
    const entry = classifyHostname({ observation, desired: undefined, adopted: false })
    expect(entry.classification).toBe("unmanaged_orphan")
    expect(entry.action).toBe("blocked")
  })

  it("team2-1: adoptHostnames に含まれれば adopt_cleanup に切り替わる", () => {
    const observation: HostnameObservation = {
      hostname: "inucon-team2-1",
      proxmoxVm: Option.none(),
      cloudflareRouteCount: 1,
      cloudflareIngressCount: 1,
      cloudflareAppCount: 1
    }
    const entry = classifyHostname({ observation, desired: undefined, adopted: true })
    expect(entry.classification).toBe("unmanaged_orphan")
    expect(entry.action).toBe("adopt_cleanup")
  })

  it("desired 有り + VM 有り + CF 有り → in_sync + noop", () => {
    const observation: HostnameObservation = {
      hostname: "inucon-team1-1",
      proxmoxVm: Option.some({ vmid: 1101, status: "running" }),
      cloudflareRouteCount: 1,
      cloudflareIngressCount: 1,
      cloudflareAppCount: 1
    }
    const desired: HostnameDesired = {
      hostname: "inucon-team1-1",
      contestId: CONTEST,
      teamId: Option.some(TEAM_1),
      instanceId: Option.some(INSTANCE_1_1),
      instanceStatus: Option.some("running"),
      cloudflareBindingIds: [BINDING_DNS],
      proxmoxBindingIds: [BINDING_VM]
    }
    const entry = classifyHostname({ observation, desired, adopted: false })
    expect(entry.classification).toBe("in_sync")
    expect(entry.action).toBe("noop")
  })

  // review #1: 片方だけ CF resource が欠けていたら drift として捕まえる。
  // 従来 `&&` 判定だと DNS だけ / Access だけ消えたケースを in_sync に落として
  // いた。
  it.each([
    { route: 1, app: 0 },
    { route: 0, app: 1 }
  ])("desired 有り + VM 有り + CF が片方だけ欠損(route=$route, app=$app) → drifted + cleanup", ({ route, app }) => {
    const observation: HostnameObservation = {
      hostname: "inucon-team1-1",
      proxmoxVm: Option.some({ vmid: 1101, status: "running" }),
      cloudflareRouteCount: route,
      cloudflareIngressCount: route,
      cloudflareAppCount: app
    }
    const desired: HostnameDesired = {
      hostname: "inucon-team1-1",
      contestId: CONTEST,
      teamId: Option.some(TEAM_1),
      instanceId: Option.some(INSTANCE_1_1),
      instanceStatus: Option.some("running"),
      cloudflareBindingIds: [],
      proxmoxBindingIds: [BINDING_VM]
    }
    const entry = classifyHostname({ observation, desired, adopted: false })
    expect(entry.classification).toBe("drifted")
    expect(entry.action).toBe("cleanup")
  })

  it("desired 無し + CF route が複数(duplicate) → ambiguous + blocked", () => {
    const observation: HostnameObservation = {
      hostname: "inucon-team1-1",
      proxmoxVm: Option.none(),
      cloudflareRouteCount: 2,
      cloudflareIngressCount: 1,
      cloudflareAppCount: 1
    }
    const entry = classifyHostname({ observation, desired: undefined, adopted: true })
    // 重複はどの分類より優先: adopted であっても apply させない
    expect(entry.classification).toBe("ambiguous")
    expect(entry.action).toBe("blocked")
  })

  // review round 9 #1: ingress record が 2 個ある状態も ambiguous として block。
  it("cloudflareIngressCount > 1 でも ambiguous + blocked (round 9)", () => {
    const observation: HostnameObservation = {
      hostname: "inucon-team1-1",
      proxmoxVm: Option.some({ vmid: 1101, status: "running" }),
      cloudflareRouteCount: 1,
      cloudflareIngressCount: 2,
      cloudflareAppCount: 1
    }
    const entry = classifyHostname({ observation, desired: undefined, adopted: false })
    expect(entry.classification).toBe("ambiguous")
    expect(entry.action).toBe("blocked")
  })

  it("desired 有り + Instance が deleted 化済み(binding のみ残存) → managed_orphan + cleanup", () => {
    const observation: HostnameObservation = {
      hostname: "inucon-team1-1",
      proxmoxVm: Option.none(),
      cloudflareRouteCount: 1,
      cloudflareIngressCount: 1,
      cloudflareAppCount: 1
    }
    const desired: HostnameDesired = {
      hostname: "inucon-team1-1",
      contestId: CONTEST,
      teamId: Option.some(TEAM_1),
      instanceId: Option.some(INSTANCE_1_1),
      instanceStatus: Option.some("deleted"),
      cloudflareBindingIds: [BINDING_DNS],
      proxmoxBindingIds: []
    }
    const entry = classifyHostname({ observation, desired, adopted: false })
    expect(entry.classification).toBe("managed_orphan")
    expect(entry.action).toBe("cleanup")
  })

  // review round 5 #1: 過去 apply で全 cleanup 済み(binding も CF resource も 0)
  // なのに Instance が deleted で残っている状態を無限に cleanup ループしない。
  it("Instance deleted + binding 0 + CF 観測 0 → in_sync + noop (managed_orphan_clean)", () => {
    const observation: HostnameObservation = {
      hostname: "inucon-team1-1",
      proxmoxVm: Option.none(),
      cloudflareRouteCount: 0,
      cloudflareIngressCount: 0,
      cloudflareAppCount: 0
    }
    const desired: HostnameDesired = {
      hostname: "inucon-team1-1",
      contestId: CONTEST,
      teamId: Option.some(TEAM_1),
      instanceId: Option.some(INSTANCE_1_1),
      instanceStatus: Option.some("deleted"),
      cloudflareBindingIds: [],
      proxmoxBindingIds: []
    }
    const entry = classifyHostname({ observation, desired, adopted: false })
    expect(entry.classification).toBe("in_sync")
    expect(entry.action).toBe("noop")
    expect(entry.reason).toBe("managed_orphan_clean")
  })

  // review round 5 #2: missing でも「Instance は running のまま / VM も CF も
  // 全消し済み / binding も 0」なら cleanup で消せるものが無いので noop。
  // Instance 状態遷移は Task 12 の担当。
  it("Instance running + VM 無し + CF 観測 0 + binding 0 → missing + noop", () => {
    const observation: HostnameObservation = {
      hostname: "inucon-team1-1",
      proxmoxVm: Option.none(),
      cloudflareRouteCount: 0,
      cloudflareIngressCount: 0,
      cloudflareAppCount: 0
    }
    const desired: HostnameDesired = {
      hostname: "inucon-team1-1",
      contestId: CONTEST,
      teamId: Option.some(TEAM_1),
      instanceId: Option.some(INSTANCE_1_1),
      instanceStatus: Option.some("running"),
      cloudflareBindingIds: [],
      proxmoxBindingIds: []
    }
    const entry = classifyHostname({ observation, desired, adopted: false })
    expect(entry.classification).toBe("missing")
    expect(entry.action).toBe("noop")
    expect(entry.reason).toBe("missing_clean_pending_db")
  })
})

describe("computePlanDigest", () => {
  const baseEntry: ReconciliationEntry = {
    hostname: "inucon-team1-1",
    classification: "missing",
    action: "cleanup",
    reason: "vm_missing",
    proxmoxVmObserved: false,
    cloudflareRouteCount: 1,
    cloudflareIngressCount: 1,
    cloudflareAppCount: 1,
    bindingIds: [BINDING_VM],
    instanceId: Option.some(INSTANCE_1_1)
  }

  it("同一 entries の順序が異なっても同じ digest を返す(canonical sort)", () => {
    const other: ReconciliationEntry = {
      ...baseEntry,
      hostname: "inucon-team2-1",
      classification: "unmanaged_orphan",
      action: "blocked",
      instanceId: Option.none(),
      bindingIds: []
    }
    const a = computePlanDigest({
      contestId: CONTEST,
      contestRevision: 2,
      entries: [baseEntry, other],
      adoptHostnames: []
    })
    const b = computePlanDigest({
      contestId: CONTEST,
      contestRevision: 2,
      entries: [other, baseEntry],
      adoptHostnames: []
    })
    expect(a).toBe(b)
    expect(a).toMatch(/^[a-f0-9]{64}$/) // SHA-256 hex
  })

  it("adoptHostnames は plan の一部として digest に含まれる", () => {
    const withoutAdopt = computePlanDigest({
      contestId: CONTEST,
      contestRevision: 2,
      entries: [baseEntry],
      adoptHostnames: []
    })
    const withAdopt = computePlanDigest({
      contestId: CONTEST,
      contestRevision: 2,
      entries: [baseEntry],
      adoptHostnames: ["inucon-team2-1"]
    })
    expect(withoutAdopt).not.toBe(withAdopt)
  })

  it("contestRevision が違えば digest が変わる(stale 検出)", () => {
    const r2 = computePlanDigest({
      contestId: CONTEST,
      contestRevision: 2,
      entries: [baseEntry],
      adoptHostnames: []
    })
    const r3 = computePlanDigest({
      contestId: CONTEST,
      contestRevision: 3,
      entries: [baseEntry],
      adoptHostnames: []
    })
    expect(r2).not.toBe(r3)
  })
})
