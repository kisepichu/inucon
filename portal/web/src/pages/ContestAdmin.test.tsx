import { render, screen, waitFor } from "@testing-library/react"
import userEvent, { type UserEvent } from "@testing-library/user-event"
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
  ReconciliationPlanRequest,
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
// - apply / cleanup に送る planDigest は「同じ adoptHostnames で取った plan」の
//   digest (adopt 付き apply は adopt 付きで取り直した plan、cleanup は adopt=[])
// - cleanup の対象 hostname / VMID は server の cleanupTarget をそのまま表示する
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

type PlanEntry = ReconciliationPlan["entries"][number]

const planEntry = (overrides: Partial<PlanEntry> & Pick<PlanEntry, "hostname">): PlanEntry => ({
  classification: "in_sync",
  action: "noop",
  reason: "in_sync",
  proxmoxVmid: null,
  cloudflareRouteCount: 0,
  cloudflareIngressCount: 0,
  cloudflareAppCount: 0,
  bindingIds: [],
  instanceId: null,
  cleanupTarget: false,
  ...overrides
})

// adopt=[] の plan では blocked になる unmanaged_orphan。
const orphanEntry = (hostname: string): PlanEntry =>
  planEntry({
    hostname,
    classification: "unmanaged_orphan",
    action: "blocked",
    reason: "requires_adopt_confirmation",
    cloudflareRouteCount: 1,
    cloudflareAppCount: 1
  })

// planReconciliation の fake。server と同じく adoptHostnames に含まれる
// unmanaged_orphan だけが adopt_cleanup に変わり、digest は adoptHostnames ごとに
// 別の値になる (server では adopt=[] の digest を adopt 付き apply に送ると必ず
// StaleReconciliationPlan、cleanup は adopt=[] で再計算する)。
const fakePlanServer =
  (entries: ReadonlyArray<PlanEntry>) =>
  async (_contestId: ContestId, body: ReconciliationPlanRequest): Promise<ReconciliationPlan> => {
    const adopt = [...body.adoptHostnames].sort()
    return {
      contestId: contestFixture.id,
      contestRevision: contestFixture.revision,
      planDigest: `digest[${adopt.join(",")}]`,
      generatedAt: 100,
      adoptHostnames: body.adoptHostnames,
      entries: entries.map((e) =>
        e.classification === "unmanaged_orphan" && adopt.includes(e.hostname)
          ? { ...e, action: "adopt_cleanup", reason: "adopted_for_cleanup" }
          : e
      )
    }
  }

const operationFixture: Operation = {
  id: "op-1",
  contestId: contestFixture.id,
  kind: "reconcile",
  status: "queued",
  actor: { kind: "admin", userId: "u-admin" },
  planDigest: "digest[]",
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
let planSpy: MockInstance<typeof api.planReconciliation>
let applySpy: MockInstance<typeof api.applyReconciliation>
let cleanupSpy: MockInstance<typeof api.requestContestCleanup>
let opsListSpy: MockInstance
let artifactsSpy: MockInstance
let startSpy: MockInstance
let finalizeSpy: MockInstance

beforeEach(() => {
  contestSpy = vi.spyOn(api, "getAdminContest").mockResolvedValue(contestFixture) as unknown as MockInstance
  teamsSpy = vi.spyOn(api, "listTeams").mockResolvedValue(teamsFixture as Array<TeamWithMembers>) as unknown as MockInstance
  readinessSpy = vi.spyOn(api, "getContestReadiness").mockResolvedValue(readinessFixture as Array<ReadinessCheck>) as unknown as MockInstance
  planSpy = vi.spyOn(api, "planReconciliation").mockImplementation(fakePlanServer([orphanEntry("inucon-team1-1")]))
  applySpy = vi.spyOn(api, "applyReconciliation").mockResolvedValue(operationFixture)
  cleanupSpy = vi.spyOn(api, "requestContestCleanup").mockResolvedValue({ ...operationFixture, kind: "cleanup" })
  opsListSpy = vi.spyOn(api, "listContestOperations").mockResolvedValue([]) as unknown as MockInstance
  artifactsSpy = vi.spyOn(api, "listAdminContestArtifacts").mockResolvedValue([artifactFixture]) as unknown as MockInstance
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

// apply / cleanup に渡した planDigest が「同じ adoptHostnames で呼んだ
// planReconciliation の戻り値」の digest であることを spy の履歴から確かめる。
// 別の adoptHostnames で取った plan の digest を流用すると server は必ず stale。
const digestsPlannedWith = async (adoptHostnames: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
  const key = [...adoptHostnames].sort().join(",")
  const digests: Array<string> = []
  for (const [i, [, body]] of planSpy.mock.calls.entries()) {
    if ([...body.adoptHostnames].sort().join(",") !== key) continue
    const result = planSpy.mock.results[i]
    if (result?.type === "return") digests.push((await result.value).planDigest)
  }
  return digests
}

const openReconciliationAndDiagnose = async (user: UserEvent) => {
  await screen.findByRole("heading", { level: 1 })
  await user.click(screen.getByRole("tab", { name: /Reconciliation/ }))
  await user.click(await screen.findByRole("button", { name: /^診断$/ }))
  await waitFor(() => expect(planSpy).toHaveBeenCalledWith(contestFixture.id, { adoptHostnames: [] }))
}

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

  it("Reconciliation: adopt 確認後は adopt 付きで plan を取り直し、その plan を表示してその digest で apply する", async () => {
    const user = userEvent.setup()
    renderPage()
    await openReconciliationAndDiagnose(user)
    const adoptCheck = await screen.findByLabelText(/inucon-team1-1/)
    const applyBtn = screen.getByRole("button", { name: /^適用$/ })
    const replanBtn = screen.getByRole("button", { name: /adopt を反映した plan を取得/ })
    expect(applyBtn).toBeDisabled()
    expect(replanBtn).toBeDisabled()
    await user.click(adoptCheck)
    // adopt=[] の plan の digest は adopt 付き apply では必ず stale になるので、
    // adopt 付き plan を取り直すまで適用させない。
    expect(applyBtn).toBeDisabled()
    await user.click(replanBtn)
    await waitFor(() =>
      expect(planSpy).toHaveBeenLastCalledWith(contestFixture.id, { adoptHostnames: ["inucon-team1-1"] })
    )
    // operator が見る plan = apply される plan (orphan が adopt_cleanup に変わっている)
    expect(await screen.findByText("adopt_cleanup")).toBeInTheDocument()
    await waitFor(() => expect(applyBtn).toBeEnabled())
    await user.click(applyBtn)
    await waitFor(() => expect(applySpy).toHaveBeenCalledTimes(1))
    const [contestId, body] = applySpy.mock.calls[0]
    expect(contestId).toBe(contestFixture.id)
    expect(body.adoptHostnames).toEqual(["inucon-team1-1"])
    expect(await digestsPlannedWith(body.adoptHostnames)).toContain(body.planDigest)
  })

  it("Reconciliation: adopt を外すと adopt 付き plan を破棄し、取り直すまで apply できない", async () => {
    const user = userEvent.setup()
    renderPage()
    await openReconciliationAndDiagnose(user)
    const adoptCheck = await screen.findByLabelText(/inucon-team1-1/)
    const applyBtn = screen.getByRole("button", { name: /^適用$/ })
    await user.click(adoptCheck)
    await user.click(screen.getByRole("button", { name: /adopt を反映した plan を取得/ }))
    await screen.findByText("adopt_cleanup")
    await user.click(adoptCheck)
    expect(screen.queryByText("adopt_cleanup")).not.toBeInTheDocument()
    expect(screen.getByText("blocked")).toBeInTheDocument()
    expect(applyBtn).toBeDisabled()
    // チェックし直しても adopt 付き plan を取り直すまでは apply できない
    await user.click(adoptCheck)
    expect(applyBtn).toBeDisabled()
  })

  it("Reconciliation: adopt 不要な plan は adopt=[] の digest でそのまま apply する", async () => {
    planSpy.mockImplementation(
      fakePlanServer([
        planEntry({
          hostname: "inucon-team1-1",
          classification: "missing",
          action: "cleanup",
          reason: "vm_missing",
          cloudflareRouteCount: 1,
          cleanupTarget: true
        })
      ])
    )
    const user = userEvent.setup()
    renderPage()
    await openReconciliationAndDiagnose(user)
    const applyBtn = await screen.findByRole("button", { name: /^適用$/ })
    await waitFor(() => expect(applyBtn).toBeEnabled())
    await user.click(applyBtn)
    await waitFor(() => expect(applySpy).toHaveBeenCalledTimes(1))
    const [, body] = applySpy.mock.calls[0]
    expect(body.adoptHostnames).toEqual([])
    expect(await digestsPlannedWith([])).toContain(body.planDigest)
  })

  it("stale plan (409 StaleReconciliationPlan) は再診断を促すメッセージを表示", async () => {
    applySpy.mockRejectedValueOnce(new ApiError("StaleReconciliationPlan", 409))
    const user = userEvent.setup()
    renderPage()
    await openReconciliationAndDiagnose(user)
    await user.click(await screen.findByLabelText(/inucon-team1-1/))
    await user.click(screen.getByRole("button", { name: /adopt を反映した plan を取得/ }))
    await screen.findByText("adopt_cleanup")
    await user.click(screen.getByRole("button", { name: /^適用$/ }))
    expect(await screen.findByText(/状態が変わりました/)).toBeInTheDocument()
  })

  describe("Reconciliation タブの cleanup", () => {
    const finishedContest: Contest = { ...contestFixture, status: "finished" }
    const cleanupPlanEntries: ReadonlyArray<PlanEntry> = [
      planEntry({
        hostname: "inucon-team1-1",
        proxmoxVmid: 1101,
        cloudflareRouteCount: 1,
        cloudflareIngressCount: 1,
        cloudflareAppCount: 1,
        cleanupTarget: true
      }),
      // 実体は全部消え、Instance を deleted に落とす仕事だけが残っている
      planEntry({
        hostname: "inucon-team1-2",
        classification: "missing",
        reason: "missing_clean_pending_db",
        cleanupTarget: true
      }),
      planEntry({ hostname: "inucon-team2-1", reason: "managed_orphan_clean" })
    ]

    beforeEach(() => {
      contestSpy.mockResolvedValue(finishedContest)
      planSpy.mockImplementation(fakePlanServer(cleanupPlanEntries))
    })

    it("server が示す cleanup 対象の hostname / VMID を表示し、確認後に adopt=[] plan の digest で requestContestCleanup を呼ぶ", async () => {
      const user = userEvent.setup()
      renderPage()
      await openReconciliationAndDiagnose(user)
      const targets = await screen.findAllByTestId("cleanup-target")
      expect(targets.map((t) => t.textContent)).toEqual([
        expect.stringMatching(/inucon-team1-1.*1101/),
        expect.stringMatching(/inucon-team1-2.*なし/)
      ])
      const cleanupBtn = screen.getByRole("button", { name: /^cleanup 実行$/ })
      expect(cleanupBtn).toBeDisabled()
      await user.click(screen.getByLabelText(/影響を確認しました/))
      expect(cleanupBtn).toBeEnabled()
      await user.click(cleanupBtn)
      await waitFor(() => expect(cleanupSpy).toHaveBeenCalledTimes(1))
      const [contestId, body] = cleanupSpy.mock.calls[0]
      expect(contestId).toBe(contestFixture.id)
      expect(await digestsPlannedWith([])).toContain(body.planDigest)
      expect(await screen.findByText(/Operation を発行しました/)).toBeInTheDocument()
    })

    it("blocked な entry がある間は押せず、先に adopt して適用するよう示す (adopt 付き plan を表示中も同じ)", async () => {
      planSpy.mockImplementation(fakePlanServer([...cleanupPlanEntries, orphanEntry("inucon-team3-1")]))
      const user = userEvent.setup()
      renderPage()
      await openReconciliationAndDiagnose(user)
      const cleanupBtn = await screen.findByRole("button", { name: /^cleanup 実行$/ })
      await user.click(screen.getByLabelText(/影響を確認しました/))
      expect(cleanupBtn).toBeDisabled()
      expect(screen.getByText(/先に adopt して適用/)).toBeInTheDocument()
      // adopt 付き plan では blocked が消えるが、cleanup は server が adopt=[] で
      // plan を取り直すので押せないまま。
      await user.click(screen.getByLabelText(/inucon-team3-1/))
      await user.click(screen.getByRole("button", { name: /adopt を反映した plan を取得/ }))
      await screen.findByText("adopt_cleanup")
      expect(cleanupBtn).toBeDisabled()
      expect(cleanupSpy).not.toHaveBeenCalled()
    })

    it("NothingToReconcile (409) は既に clean として完了表示し、error にしない", async () => {
      cleanupSpy.mockRejectedValueOnce(new ApiError("NothingToReconcile", 409))
      const user = userEvent.setup()
      renderPage()
      await openReconciliationAndDiagnose(user)
      await user.click(await screen.findByLabelText(/影響を確認しました/))
      await user.click(screen.getByRole("button", { name: /^cleanup 実行$/ }))
      expect(await screen.findByText(/既に clean/)).toBeInTheDocument()
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    })

    it("finished / canceled 以外では cleanup を出さない", async () => {
      contestSpy.mockResolvedValue(contestFixture)
      const user = userEvent.setup()
      renderPage()
      await openReconciliationAndDiagnose(user)
      await screen.findByText("inucon-team1-1")
      expect(screen.queryByRole("button", { name: /^cleanup 実行$/ })).not.toBeInTheDocument()
    })
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

  it("Archive タブは admin list 経由で snapshot 行を描画し、pending 行だけに verify 入力を出す", async () => {
    // 公開 list (`listContestArtifacts`) は snapshot を除外するため、admin 画面は
    // admin list を呼ばないと off-host verify 導線に到達できない。
    artifactsSpy.mockResolvedValue([
      artifactFixture,
      {
        ...artifactFixture,
        id: "art-snapshot",
        kind: "snapshot",
        sizeBytes: 212992,
        offHostStatus: "pending",
        sha256: "a".repeat(64)
      }
    ])
    const user = userEvent.setup()
    renderPage()
    await screen.findByText(/準備中/)
    await user.click(screen.getByRole("tab", { name: /Archive/ }))
    await waitFor(() => expect(artifactsSpy).toHaveBeenCalledWith(contestFixture.id))
    // snapshot 行が列挙される
    expect(await screen.findByText("snapshot")).toBeInTheDocument()
    expect(screen.getByText("212992")).toBeInTheDocument()
    // verify 入力は pending の snapshot 行にだけ出る (not_applicable には出さない)
    const shaInputs = screen.getAllByLabelText(/SHA-256/i)
    expect(shaInputs).toHaveLength(1)
    expect(shaInputs[0]).toHaveAttribute("id", "sha-art-snapshot")
    expect(screen.getAllByRole("button", { name: /off-host verify/i })).toHaveLength(1)
    // download は全 kind を AdminOnly 経路に通す (公開 download は snapshot を 404
    // にし、かつ max-age=60 で再生成後の stale bytes を返しうる)。
    const links = screen.getAllByRole("link", { name: /download/i })
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/api/admin/artifacts/art-scoreboard/download",
      "/api/admin/artifacts/art-snapshot/download"
    ])
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
