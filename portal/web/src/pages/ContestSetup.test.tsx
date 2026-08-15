import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { MockInstance } from "vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Contest } from "shared/schemas"
import { api } from "../api.ts"
import { ContestSetup } from "./ContestSetup.tsx"

// Task 5: 5-section wizard(Metadata / Schedule / Teams / Capacity / Review)を
// 1 ページで表示し、「確認へ」で Review パネルを開いてから「作成」で
// api.createContestDraft を叩く単一ページ設計。
//
// 検証は「サーバー契約のリクエストボディが期待どおり」「入力バリデーションが
// 見せるべきメッセージを表示する」の 2 点に集中する。全画面 snapshot は取らない。

const contestFixture = {
  id: "c-new",
  edition: 2,
  name: "INUCON #2",
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


let listSpy: MockInstance
let createSpy: MockInstance

beforeEach(() => {
  listSpy = vi.spyOn(api, "listAdminContests").mockResolvedValue([]) as unknown as MockInstance
  createSpy = vi.spyOn(api, "createContestDraft").mockResolvedValue(contestFixture) as unknown as MockInstance
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("ContestSetup", () => {
  it("edition を入力後「確認へ」で Review が開き、合計 VM 数(quota=3 × 1 チーム)が表示される", async () => {
    const user = userEvent.setup()
    render(<ContestSetup onCreated={vi.fn()} />)
    await user.clear(screen.getByLabelText("開催回"))
    await user.type(screen.getByLabelText("開催回"), "2")
    await user.click(screen.getByRole("button", { name: "確認へ" }))
    expect(screen.getByText("合計 VM: 3台")).toBeInTheDocument()
  })

  it("scheduledEndAt を入れて accessClosesAt を触らないと、accessClosesAt が自動的に end と同じ値になる", async () => {
    const user = userEvent.setup()
    render(<ContestSetup onCreated={vi.fn()} />)
    const startInput = screen.getByLabelText("開始") as HTMLInputElement
    const endInput = screen.getByLabelText("終了") as HTMLInputElement
    const accessCloseInput = screen.getByLabelText("Access 閉鎖") as HTMLInputElement
    await user.type(startInput, "2026-08-01T10:00")
    await user.type(endInput, "2026-08-01T18:00")
    // accessCloses は触らない
    await user.click(screen.getByRole("button", { name: "確認へ" }))
    // wizard は end と同じ値を accessCloses に埋める
    expect(accessCloseInput.value).toBe("2026-08-01T18:00")
  })

  it("「作成」で api.createContestDraft がフォーム値どおりのペイロードで呼ばれる", async () => {
    const user = userEvent.setup()
    const onCreated = vi.fn()
    render(<ContestSetup onCreated={onCreated} />)
    await user.clear(screen.getByLabelText("開催回"))
    await user.type(screen.getByLabelText("開催回"), "2")
    await user.clear(screen.getByLabelText("大会名"))
    await user.type(screen.getByLabelText("大会名"), "INUCON #2")
    await user.click(screen.getByRole("button", { name: "確認へ" }))
    await user.click(screen.getByRole("button", { name: "作成" }))

    expect(createSpy).toHaveBeenCalledTimes(1)
    const call = createSpy.mock.calls[0][0]
    expect(call).toMatchObject({
      edition: 2,
      name: "INUCON #2",
      problemKey: "private-isu",
      templateVmid: 9100,
      instanceQuota: 3,
      scheduledStartAt: null,
      scheduledEndAt: null,
      accessClosesAt: null,
      cleanupAt: null
    })
    expect(onCreated).toHaveBeenCalledWith(contestFixture)
  })

  it("listAdminContests の結果から次の edition 既定値を計算する(最大 live edition + 1)", async () => {
    listSpy.mockResolvedValueOnce([
      { ...contestFixture, id: "c1", edition: 1, status: "finished" },
      { ...contestFixture, id: "c2", edition: 3, status: "canceled" }
    ])
    const user = userEvent.setup()
    render(<ContestSetup onCreated={vi.fn()} />)
    // canceled(edition=3)は無視、live edition の最大は 1 なので既定は 2
    const editionInput = await screen.findByLabelText("開催回") as HTMLInputElement
    // 非同期で fetch 後に反映されるまで待機(userEvent.setup が microtask を排出)
    await user.click(screen.getByRole("button", { name: "確認へ" }))
    expect(editionInput.value).toBe("2")
  })
})
