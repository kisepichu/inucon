import { useCallback, useEffect, useState } from "react"
import { Link, Navigate, Route, Routes } from "react-router-dom"
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
    return <p>Loading...</p>
  }

  if (status === "error") {
    return <p className="error">読み込みに失敗しました。再読み込みしてください。</p>
  }

  if (status === "unauthenticated" || me === null) {
    return <Login />
  }

  return (
    <>
      <header className="app-header">
        <div>
          <strong>{contest?.name ?? "INUCON"}</strong>
          {contest && <span> ({contest.status})</span>}
        </div>
        <nav>
          <Link to="/">Scoreboard</Link>
          <Link to="/team">Team</Link>
          {me.user.isAdmin && <Link to="/admin">Admin</Link>}
        </nav>
        <div className="user">
          <span>{me.user.displayName}</span>
          <button type="button" onClick={handleLogout}>
            logout
          </button>
        </div>
      </header>
      <main>
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
