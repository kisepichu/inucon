import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { BenchJobDetail } from "shared/schemas"
import { api } from "../api.ts"
import { JobDetail } from "./JobDetail.tsx"

// readiness の rehearsal は purpose=rehearsal・status=finished・passed=true の job だけを
// 数える (score は見ない)。finished でも passed=false なら start は通らないので、
// JobDetail は判定 (passed) を status / score と別に出す。

const jobFixture = (overrides: Partial<BenchJobDetail>): BenchJobDetail =>
  ({
    id: "job-r1",
    contestId: "c-2",
    teamId: "team1",
    targetIp: "10.100.1.11",
    targetPort: 80,
    status: "finished",
    purpose: "rehearsal",
    score: 1200,
    passed: false,
    errorMessage: null,
    enqueuedAt: 100,
    startedAt: 110,
    finishedAt: 200,
    log: "",
    ...overrides
  }) as unknown as BenchJobDetail

const renderJob = () =>
  render(
    <MemoryRouter initialEntries={["/jobs/job-r1"]}>
      <Routes>
        <Route path="/jobs/:id" element={<JobDetail />} />
      </Routes>
    </MemoryRouter>
  )

afterEach(() => {
  vi.restoreAllMocks()
})

describe("JobDetail", () => {
  it.each([
    { passed: false, verdict: "fail" },
    { passed: true, verdict: "pass" },
    { passed: null, verdict: "-" }
  ])("判定 (passed=$passed) を $verdict として表示する", async ({ passed, verdict }) => {
    vi.spyOn(api, "getBenchJob").mockResolvedValue(jobFixture({ passed }))
    renderJob()
    expect((await screen.findByText("判定")).nextElementSibling).toHaveTextContent(new RegExp(`^${verdict}$`))
  })

  it("rehearsal には readiness に数えられる条件を示す", async () => {
    vi.spyOn(api, "getBenchJob").mockResolvedValue(jobFixture({}))
    renderJob()
    expect(await screen.findByText(/finished かつ判定 pass の rehearsal だけが readiness/)).toBeInTheDocument()
  })

  it("competition には rehearsal の条件を出さない", async () => {
    vi.spyOn(api, "getBenchJob").mockResolvedValue(jobFixture({ purpose: "competition" }))
    renderJob()
    await screen.findByText("判定")
    expect(screen.queryByText(/readiness/)).not.toBeInTheDocument()
  })
})
