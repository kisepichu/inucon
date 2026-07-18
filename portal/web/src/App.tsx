import { useCallback, useEffect, useState } from "react"
import { Navigate, NavLink, Route, Routes } from "react-router-dom"
import type { Contest, Me } from "shared/schemas"
import { ApiError, api } from "./api.ts"
import { Admin } from "./pages/Admin.tsx"
import { JobDetail } from "./pages/JobDetail.tsx"
import { Login } from "./pages/Login.tsx"
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
    if (status !== "authenticated") {
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

  if (status === "unauthenticated" || me === null) {
    return <Login />
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
            <NavLink to="/team" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
              Team
            </NavLink>
            {me.user.isAdmin && (
              <NavLink to="/admin" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
                Admin
              </NavLink>
            )}
          </nav>
          <div className="app-user">
            <span className="app-user-name">{me.user.displayName}</span>
            <button type="button" className="btn btn-sm btn-ghost-dark" onClick={handleLogout}>
              logout
            </button>
          </div>
        </div>
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Scoreboard />} />
          <Route path="/team" element={<Team me={me} />} />
          <Route path="/jobs/:id" element={<JobDetail />} />
          {me.user.isAdmin && <Route path="/admin" element={<Admin />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  )
}
