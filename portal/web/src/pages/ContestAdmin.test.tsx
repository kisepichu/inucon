import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import type { MockInstance } from "vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  Artifact,
  Contest,
  ContestId,
  Operation,
  ReadinessCheck,
  ReconciliationPlan,
  TeamWithMembers
} from "shared/schemas"
import { ApiError, api } from "../api.ts"
import { ContestAdmin } from "./ContestAdmin.tsx"

// Task 13 Step 1: ContestAdmin タブ (Overview / Teams / Readiness / Reconciliation /
// Operations / Archive) の主要挙動を @testing-library/react で検証する。
//
// 検証観点:
// - status ラベル / アクション enablement が Contest.status に一貫する
// - failing readiness を fail → warn → pass 順にグルーピング表示
// - unmanaged_orphan は adopt チェックボックスを要求し、確認しないと apply 不可
// - apply は plan の planDigest をそのまま送る (改変しない)
// - dangerous-action の確認 checkbox が入るまでボタンが押せない
// - stale plan (409) は再診断を促し、free-form 文字列を backend に送らない
// - Operation polling は terminal status で自動停止する

const contestFixture: Contest = {
  id: "c-2" as unknown as ContestId,
  edition: 2,
  name: "INUCON #2",
  problemKey: "private-isu",
  problemRevision: "2026-08",
  templateVmid: 9100,
  status: "preparing",
  instanceQuota: 3,
  scheduledStartAt: 1_800_000_000_000,
  scheduledEndAt: 1_800_007_200_000,
  accessClosesAt: 1_800_007_200_000,
  cleanupAt: null,
  accessClosedAt: null,
  cleanupCompletedAt: null,
  startedAt: null,
  finalizingAt: null,
  finishedAt: null,
  canceledAt: null,
  revision: 3
} as unknown as Contest

const teamsFixture: ReadonlyArray<TeamWithMembers> = [
  {
    id: "team1",
    contestId: contestFixture.id,
    teamNumber: 1,
    name: "team1",
    desiredInstanceCount: 3,
    members: [
      { id: "u1", githubLogin: "alice", displayName: "Alice" }
    ]
  } as unknown as TeamWithMembers
]

const readinessFixture: ReadonlyArray<ReadinessCheck> = [
  { key: "portal_db", status: "pass", summary: "ok" },
  { key: "template", status: "warn", summary: "estimated" },
  { key: "runner", status: "fail", summary: "stale heartbeat" }
]

const planFixture: ReconciliationPlan = {
  contestId: contestFixture.id,
  contestRevision: contestFixture.revision,
  planDigest: "digest-abc",
  generatedAt: 100,
  adoptHostnames: [],
  entries: [
    {
      hostname: "inucon-team1-1",
      classification: "unmanaged_orphan",
      action: "blocked",
      reason: "no binding but present on CF",
      proxmoxVmObserved: false,
      cloudflareRouteCount: 1,
      cloudflareIngressCount: 0,
      cloudflareAppCount: 1,
      bindingIds: [],
      instanceId: null
    }
  ]
} as unknown as ReconciliationPlan

const operationFixture: Operation = {
  id: "op-1",
  contestId: contestFixture.id,
  kind: "reconcile",
  status: "queued",
  actor: { kind: "admin", userId: "u-admin" },
  planDigest: planFixture.planDigest,
  contestRevision: contestFixture.revision,
  sanitizedError: null,
  createdAt: 100,
  startedAt: null,
  finishedAt: null
} as unknown as Operation

const artifactFixture: Artifact = {
  id: "art-scoreboard",
  contestId: contestFixture.id,
  kind: "scoreboard",
  sha256: "0".repeat(64),
  sizeBytes: 128,
  offHostStatus: "not_applicable",
  verifiedAt: null,
  createdAt: 100
} as unknown as Artifact

let contestSpy: MockInstance
let teamsSpy: MockInstance
let readinessSpy: MockInstance
let planSpy: MockInstance
let applySpy: MockInstance
let opsListSpy: MockInstance
let artifactsSpy: MockInstance
let startSpy: MockInstance
let finalizeSpy: MockInstance

beforeEach(() => {
  contestSpy = vi.spyOn(api, "getAdminContest").mockResolvedValue(contestFixture) as unknown as MockInstance
  teamsSpy = vi.spyOn(api, "listTeams").mockResolvedValue(teamsFixture as Array<TeamWithMembers>) as unknown as MockInstance
  readinessSpy = vi.spyOn(api, "getContestReadiness").mockResolvedValue(readinessFixture as Array<ReadinessCheck>) as unknown as MockInstance
  planSpy = vi.spyOn(api, "planReconciliation").mockResolvedValue(planFixture) as unknown as MockInstance
  applySpy = vi.spyOn(api, "applyReconciliation").mockResolvedValue(operationFixture) as unknown as MockInstance
  opsListSpy = vi.spyOn(api, "listContestOperations").mockResolvedValue([]) as unknown as MockInstance
  artifactsSpy = vi.spyOn(api, "listContestArtifacts").mockResolvedValue([artifactFixture]) as unknown as MockInstance
  startSpy = vi.spyOn(api, "requestContestStart").mockResolvedValue(operationFixture) as unknown as MockInstance
  finalizeSpy = vi.spyOn(api, "requestContestFinalize").mockResolvedValue(operationFixture) as unknown as MockInstance
})

afterEach(() => {
  vi.restoreAllMocks()
})

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={[`/admin/contests/${contestFixture.id}`]}>
      <Routes>
        <Route path="/admin/contests/:contestId" element={<ContestAdmin />} />
      </Routes>
    </MemoryRouter>
  )

describe("ContestAdmin", () => {
  it("Overview タブは Contest.status ラベル (準備中) を表示し、start は preparing で有効", async () => {
    renderPage()
    await waitFor(() => expect(contestSpy).toHaveBeenCalled())
    // 状態ラベル
    expect(await screen.findByText(/準備中/)).toBeInTheDocument()
    // start ボタンは初期は disabled (確認 checkbox 未チェック)
    const startBtn = await screen.findByRole("button", { name: /開始/ })
    expect(startBtn).toBeDisabled()
  })

  it("start は確認 checkbox を tick してから有効になり、backend には free-form 文字列を送らない", async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText(/準備中/)
    const startBtn = await screen.findByRole("button", { name: /開始/ })
    expect(startBtn).toBeDisabled()
    const confirmCheck = await screen.findByLabelText(/影響を確認しました/)
    await user.click(confirmCheck)
    expect(startBtn).not.toBeDisabled()
    await user.click(startBtn)
    await waitFor(() => expect(startSpy).toHaveBeenCalledTimes(1))
    // 送るのは expectedRevision のみ (free-form 文字列は無い)
    expect(startSpy).toHaveBeenCalledWith(contestFixture.id, { expectedRevision: contestFixture.revision })
  })

  it("Readiness タブは fail を先に、summary をそのまま表示する", async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText(/準備中/)
    await user.click(screen.getByRole("tab", { name: /Readiness/ }))
    await waitFor(() => expect(readinessSpy).toHaveBeenCalled())
    // fail が先頭に表示される
    const items = screen.getAllByTestId("readiness-item")
    expect(items[0].textContent).toContain("runner")
    expect(items[0].textContent).toContain("stale heartbeat")
  })

  it("Reconciliation タブ: unmanaged_orphan は adopt checkbox を要求、未チェックだと apply 押下不可", async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText(/準備中/)
    await user.click(screen.getByRole("tab", { name: /Reconciliation/ }))
    // 診断ボタン → plan 取得
    await user.click(await screen.findByRole("button", { name: /診断/ }))
    await waitFor(() => expect(planSpy).toHaveBeenCalled())
    // adopt チェックボックスが hostname 名で出る
    const adoptCheck = await screen.findByLabelText(/inucon-team1-1/)
    expect(adoptCheck).not.toBeChecked()
    // apply ボタンは初期は無効 (adopt 未確認)
    const applyBtn = screen.getByRole("button", { name: /^適用$/ })
    expect(applyBtn).toBeDisabled()
    await user.click(adoptCheck)
    expect(applyBtn).not.toBeDisabled()
    await user.click(applyBtn)
    await waitFor(() => expect(applySpy).toHaveBeenCalledTimes(1))
    // planDigest はサーバーからのそのまま。adopt は checkbox で確認した hostname のみ。
    expect(applySpy).toHaveBeenCalledWith(contestFixture.id, {
      planDigest: planFixture.planDigest,
      adoptHostnames: ["inucon-team1-1"]
    })
  })

  it("stale plan (409 StaleReconciliationPlan) は再診断を促すメッセージを表示", async () => {
    applySpy.mockRejectedValueOnce(new ApiError("StaleReconciliationPlan", 409))
    const user = userEvent.setup()
    renderPage()
    await screen.findByText(/準備中/)
    await user.click(screen.getByRole("tab", { name: /Reconciliation/ }))
    await user.click(await screen.findByRole("button", { name: /診断/ }))
    await screen.findByLabelText(/inucon-team1-1/)
    await user.click(screen.getByLabelText(/inucon-team1-1/))
    await user.click(screen.getByRole("button", { name: /^適用$/ }))
    expect(await screen.findByText(/状態が変わりました/)).toBeInTheDocument()
  })

  it("Operations タブは operation 一覧を初回に fetch し、terminal status のときは追加 fetch しない", async () => {
    opsListSpy.mockResolvedValue([{ ...operationFixture, status: "succeeded" }])
    const user = userEvent.setup()
    renderPage()
    await screen.findByText(/準備中/)
    await user.click(screen.getByRole("tab", { name: /Operations/ }))
    await waitFor(() => expect(opsListSpy).toHaveBeenCalledTimes(1))
    // terminal だけを含む応答を受け取ったら polling が止まる (isOperationTerminal で判定)。
    // 500 ms 待って追加 fetch されないことを確認する。
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(opsListSpy).toHaveBeenCalledTimes(1)
    // 一覧表示は残っている
    expect(screen.getByText(/成功/)).toBeInTheDocument()
  })
  it("Archive タブは kind / size / checksum を表示し、確認 checksum 入力で off-host verify を呼ぶ", async () => {
    const verifySpy = vi.spyOn(api, "verifyArtifactChecksum").mockResolvedValue({
      ...artifactFixture,
      offHostStatus: "verified"
    } as unknown as Artifact) as unknown as MockInstance
    // snapshot artifact (off-host status を持つ) に差し替える
    artifactsSpy.mockResolvedValue([
      { ...artifactFixture, kind: "snapshot", offHostStatus: "pending", sha256: "a".repeat(64) }
    ])
    const user = userEvent.setup()
    renderPage()
    await screen.findByText(/準備中/)
    await user.click(screen.getByRole("tab", { name: /Archive/ }))
    // sha256 を要求される (Task 13 spec Step 4: 表示された checksum を再入力)
    const sha = await screen.findByLabelText(/SHA-256/i)
    await user.type(sha, "a".repeat(64))
    await user.click(screen.getByRole("button", { name: /off-host verify/i }))
    await waitFor(() => expect(verifySpy).toHaveBeenCalledTimes(1))
    expect(verifySpy).toHaveBeenCalledWith(artifactFixture.id, { sha256: "a".repeat(64) })
  })

  it("immediate finish は running 以外では表示されない", async () => {
    contestSpy.mockResolvedValueOnce({ ...contestFixture, status: "finished" })
    renderPage()
    await screen.findByRole("heading", { level: 1 })
    expect(screen.queryByRole("button", { name: /即時終了/ })).not.toBeInTheDocument()
  })

  it("finalize は running で確認 checkbox 後に呼ばれる", async () => {
    contestSpy.mockResolvedValueOnce({ ...contestFixture, status: "running" })
    const user = userEvent.setup()
    renderPage()
    await screen.findByText(/開催中/)
    const finishBtn = await screen.findByRole("button", { name: /即時終了/ })
    expect(finishBtn).toBeDisabled()
    const check = await screen.findByLabelText(/影響を確認しました/)
    await user.click(check)
    await user.click(finishBtn)
    await waitFor(() => expect(finalizeSpy).toHaveBeenCalledTimes(1))
    expect(finalizeSpy).toHaveBeenCalledWith(contestFixture.id, { expectedRevision: contestFixture.revision })
  })

  it("Teams タブは desiredInstanceCount とメンバーを表示する (credential フィールドは表示しない)", async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText(/準備中/)
    await user.click(screen.getByRole("tab", { name: /Teams/ }))
    await waitFor(() => expect(teamsSpy).toHaveBeenCalled())
    expect(await screen.findByText("team1")).toBeInTheDocument()
    // メンバー githubLogin が表示される
    expect(screen.getByText(/alice/)).toBeInTheDocument()
    // 3 (desiredInstanceCount) を表示
    expect(screen.getByText(/3/)).toBeInTheDocument()
    // credential 系語彙が UI にまったく出ないこと
    expect(document.body.textContent).not.toMatch(/token|bearer|password|CF_API|email/i)
  })
})
