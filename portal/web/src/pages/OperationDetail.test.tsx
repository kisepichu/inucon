import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import type { MockInstance } from "vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Contest, ContestId, OperationId, OperationStatus, OperationWithSteps } from "shared/schemas"
import { api } from "../api.ts"
import { OperationDetail } from "./OperationDetail.tsx"

// OperationDetail の cancel 導線。cancel できるのは queued / failed / blocked だけで、
// 確認 checkbox を入れるまで押せず、押すと cancel endpoint を呼んで表示を更新する。

// brand 付き ID は型専用 import からは作れないので literal を cast する。
const OP_ID = "op-cancel-1" as OperationId
const CONTEST_ID = "c-2" as ContestId

// wire の Contest は Option フィールドを null で返す (web の api client は decode
// しない) ため、shared の Contest.Type とは形が一致しない。ContestAdmin.test と同じく cast する。
const contestFixture = {
  id: CONTEST_ID,
  edition: 2,
  name: "INUCON #2",
  status: "preparing",
  revision: 3
} as unknown as Contest

type Step = OperationWithSteps["steps"][number]

const step = (ordinal: number, stepKey: string, status: Step["status"]): Step => ({
  id: `step-${ordinal}` as Step["id"],
  operationId: OP_ID,
  ordinal,
  stepKey,
  status,
  attempt: status === "queued" ? 0 : 1,
  continueOnError: false,
  retryAt: null,
  leaseExpiresAt: null,
  inputSummary: "{}",
  progressJson: "{}",
  resultSummary: status === "succeeded" ? "ok" : null,
  sanitizedError: null,
  createdAt: 100,
  startedAt: status === "queued" ? null : 200,
  finishedAt: null
})

// 2 step 目が Operation の状態を決める step (blocked / failed / running) になる構成。
const SECOND_STEP_STATUS: Record<OperationStatus, Step["status"]> = {
  queued: "queued",
  running: "running",
  failed: "failed",
  blocked: "blocked",
  succeeded: "succeeded",
  canceled: "failed"
}

const operationWith = (status: OperationStatus): OperationWithSteps => ({
  id: OP_ID,
  contestId: CONTEST_ID,
  kind: "enter_contest_mode",
  status,
  actor: { kind: "scheduler" },
  planDigest: "digest-mode",
  contestRevision: 3,
  sanitizedError: null,
  createdAt: 100,
  startedAt: status === "queued" ? null : 200,
  finishedAt: null,
  steps: [
    step(0, "set_devvm_onboot_0", status === "queued" ? "queued" : "succeeded"),
    step(1, "memory_check", SECOND_STEP_STATUS[status]),
    step(2, "start_benchvm", status === "succeeded" ? "succeeded" : "queued")
  ]
})

// cancel endpoint の応答は steps を持たない Operation。
const { steps: _steps, ...canceledOperation } = operationWith("canceled")

let getSpy: MockInstance<typeof api.getAdminOperation>
// cancel は api wrapper を spy せず fetch で受け、path / method まで確かめる。
// 取得系 (getAdminOperation / getAdminContest) は api を spy するので fetch は呼ばない。
let fetchSpy: MockInstance<typeof fetch>

beforeEach(() => {
  vi.spyOn(api, "getAdminContest").mockResolvedValue(contestFixture)
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify(canceledOperation), { status: 200 }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

const renderAt = (status: OperationStatus) => {
  getSpy = vi.spyOn(api, "getAdminOperation").mockResolvedValue(operationWith(status))
  render(
    <MemoryRouter initialEntries={[`/admin/operations/${OP_ID}`]}>
      <Routes>
        <Route path="/admin/operations/:operationId" element={<OperationDetail />} />
      </Routes>
    </MemoryRouter>
  )
}

const cancelButton = () => screen.queryByRole("button", { name: "Operation を cancel" })

describe("OperationDetail の cancel", () => {
  it.each(["queued", "failed", "blocked"] as const)("%s ではボタンを出し、確認するまで押せない", async (status) => {
    const user = userEvent.setup()
    renderAt(status)
    await screen.findByRole("heading", { level: 1 })
    const button = await screen.findByRole("button", { name: "Operation を cancel" })
    expect(button).toBeDisabled()
    await user.click(button)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("running ではボタンを出さず、cancel できない理由と lease 切れでも cancel できないことを出す", async () => {
    renderAt("running")
    const reason = await screen.findByText(/実行中 \(running\) の Operation は cancel できません/)
    expect(reason).toHaveTextContent(/blocked \/ failed/)
    expect(reason).toHaveTextContent(/lease/)
    expect(reason).toHaveTextContent(/running のまま/)
    expect(cancelButton()).toBeNull()
  })

  it.each(["succeeded", "canceled"] as const)("%s ではボタンも cancel できない理由も出さない", async (status) => {
    renderAt(status)
    await screen.findByRole("heading", { level: 1 })
    expect(cancelButton()).toBeNull()
    expect(screen.queryByText(/cancel できません/)).toBeNull()
  })

  it("確認画面に kind・対象 Contest・未完了 step・外部 resource を巻き戻さないことを出す", async () => {
    renderAt("blocked")
    const panel = await screen.findByRole("region", { name: "Operation の cancel" })
    expect(panel).toHaveTextContent("コンテストモード切替")
    expect(panel).toHaveTextContent("enter_contest_mode")
    await waitFor(() => expect(panel).toHaveTextContent("INUCON #2"))
    expect(panel).toHaveTextContent(CONTEST_ID)
    const pending = screen.getAllByTestId("cancel-pending-step").map((li) => li.textContent ?? "")
    expect(pending).toHaveLength(2)
    expect(pending[0]).toContain("memory_check")
    expect(pending[1]).toContain("start_benchvm")
    expect(panel).toHaveTextContent(/外部 resource .*巻き戻しません/)
  })

  it("確認して押すと POST /api/admin/operations/:id/cancel を呼び、Operation を取り直して canceled を表示する", async () => {
    const user = userEvent.setup()
    renderAt("blocked")
    const button = await screen.findByRole("button", { name: "Operation を cancel" })
    getSpy.mockResolvedValue(operationWith("canceled"))

    await user.click(screen.getByRole("checkbox", { name: /影響を確認しました/ }))
    expect(button).toBeEnabled()
    await user.click(button)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledWith(
      `/api/admin/operations/${OP_ID}/cancel`,
      expect.objectContaining({ method: "POST" })
    )
    await waitFor(() => expect(cancelButton()).toBeNull())
    expect(screen.getByText("キャンセル")).toBeInTheDocument()
  })

  it("409 で拒否されたら理由を出し、表示を最新の状態に更新する", async () => {
    const user = userEvent.setup()
    renderAt("queued")
    const button = await screen.findByRole("button", { name: "Operation を cancel" })
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ _tag: "InvalidOperationTransition", from: "running", to: "canceled" }), {
        status: 409
      })
    )
    getSpy.mockResolvedValue(operationWith("running"))

    await user.click(screen.getByRole("checkbox", { name: /影響を確認しました/ }))
    await user.click(button)

    expect(await screen.findByRole("alert")).toHaveTextContent(/状態が変わった/)
    await waitFor(() => expect(cancelButton()).toBeNull())
    expect(screen.getByText(/実行中 \(running\) の Operation は cancel できません/)).toBeInTheDocument()
  })
})
