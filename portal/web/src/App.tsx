import { useCallback, useEffect, useState } from "react"
import { Navigate, NavLink, Route, Routes } from "react-router-dom"
import type { Contest, Me } from "shared/schemas"
import { ApiError, api, loginUrl } from "./api.ts"
import { Admin } from "./pages/Admin.tsx"
import { Contests } from "./pages/Contests.tsx"
import { ContestAdmin } from "./pages/ContestAdmin.tsx"
import { OperationDetail } from "./pages/OperationDetail.tsx"
import { ContestSetup } from "./pages/ContestSetup.tsx"
import { JobDetail } from "./pages/JobDetail.tsx"
import { Scoreboard } from "./pages/Scoreboard.tsx"
import { Team } from "./pages/Team.tsx"

type AuthStatus = "loading" | "authenticated" | "unauthenticated" | "error"

// コンテスト状態のポーリング間隔(スコアボードと同じ 10 秒。スペック §7)。
const CONTEST_POLL_MILLIS = 10_000

export function App() {
  const [status, setStatus] = useState<AuthStatus>("loading")
  const [me, setMe] = useState<Me | null>(null)
  const [contest, setContest] = useState<Contest | null>(null)

  const loadMe = useCallback(async () => {
    try {
      const result = await api.getMe()
      setMe(result)
      setStatus("authenticated")
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setStatus("unauthenticated")
      } else {
        setStatus("error")
      }
    }
  }, [])

  useEffect(() => {
    loadMe()
  }, [loadMe])

  useEffect(() => {
    if (status === "loading") {
      return
    }
    let canceled = false
    const loadContest = async () => {
      try {
        const result = await api.getContest()
        if (!canceled) {
          setContest(result)
        }
      } catch {
        // コンテスト未作成(404)等は「未作成」として扱う。
        if (!canceled) {
          setContest(null)
        }
      }
    }
    loadContest()
    const id = setInterval(loadContest, CONTEST_POLL_MILLIS)
    return () => {
      canceled = true
      clearInterval(id)
    }
  }, [status])

  const handleLogout = async () => {
    await api.logout()
    setMe(null)
    setStatus("unauthenticated")
  }

  if (status === "loading") {
    return <p className="loading">Loading...</p>
  }

  if (status === "error") {
    return (
      <p className="error-page" role="alert">
        読み込みに失敗しました。再読み込みしてください。
      </p>
    )
  }

  return (
    <>
      <header className="app-header">
        <div className="app-header-inner">
          <div className="app-brand">
            {contest?.name ?? "INUCON"}
            {contest && <span className="app-contest-status">({contest.status})</span>}
          </div>
          <nav className="app-nav">
            <NavLink to="/" end className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
              Scoreboard
            </NavLink>
            {me !== null && (
              <NavLink to="/team" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
                Team
              </NavLink>
            )}
            {me?.user.isAdmin && (
              <NavLink
                to="/admin/contests"
                className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}
              >
                Contests
              </NavLink>
            )}
            {me?.user.isAdmin && (
              <NavLink to="/admin" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
                Admin
              </NavLink>
            )}
          </nav>
          <div className="app-user">
            {me !== null ? (
              <>
                <span className="app-user-name">{me.user.displayName}</span>
                <button type="button" className="btn btn-sm btn-ghost-dark" onClick={handleLogout}>
                  logout
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => {
                  window.location.href = loginUrl
                }}
              >
                GitHub でログイン
              </button>
            )}
          </div>
        </div>
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Scoreboard />} />
          <Route path="/team" element={me !== null ? <Team me={me} /> : <Navigate to="/" replace />} />
          <Route path="/jobs/:id" element={me !== null ? <JobDetail /> : <Navigate to="/" replace />} />
          <Route path="/admin" element={me?.user.isAdmin ? <Admin /> : <Navigate to="/" replace />} />
          <Route
            path="/admin/contests"
            element={me?.user.isAdmin ? <Contests /> : <Navigate to="/" replace />}
          />
          <Route
            path="/admin/contests/new"
            element={
              me?.user.isAdmin ? (
                <ContestSetup onCreated={() => window.location.assign("/admin/contests")} />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/admin/contests/:contestId"
            element={me?.user.isAdmin ? <ContestAdmin /> : <Navigate to="/" replace />}
          />
          <Route
            path="/admin/operations/:operationId"
            element={me?.user.isAdmin ? <OperationDetail /> : <Navigate to="/" replace />}
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  )
}
