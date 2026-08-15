import { useEffect, useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import type { Contest, ScoreboardEntry } from "shared/schemas"
import { api } from "../api.ts"

const POLL_MILLIS = 10_000

const formatDate = (millis: number | null) => (millis === null ? "-" : new Date(millis).toLocaleString())

// Task 4: 公開 archive scoreboard。/api/contests で開催回一覧をロードし、
// ?contest=<id> があればその edition を、無ければ list 先頭(edition 降順の
// 最新)を選択して /api/contests/:id/scoreboard を polling する。0 contest
// (未開催)は「開催履歴はまだありません」を表示する(redirect ループなし)。
export function Scoreboard() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [contests, setContests] = useState<Array<Contest> | null>(null)
  const [entries, setEntries] = useState<Array<ScoreboardEntry> | null>(null)
  const [error, setError] = useState<string | null>(null)

  const requestedContestId = searchParams.get("contest")
  const selectedContest = useMemo<Contest | null>(() => {
    if (contests === null || contests.length === 0) return null
    if (requestedContestId !== null) {
      const found = contests.find((c) => c.id === requestedContestId)
      if (found !== undefined) return found
    }
    return contests[0]
  }, [contests, requestedContestId])

  useEffect(() => {
    let canceled = false
    const load = async () => {
      try {
        const data = await api.listContests()
        if (!canceled) {
          setContests(data)
          setError(null)
        }
      } catch {
        if (!canceled) setError("開催情報の取得に失敗しました。")
      }
    }
    load()
    return () => {
      canceled = true
    }
  }, [])

  useEffect(() => {
    if (selectedContest === null) {
      setEntries([])
      return
    }
    // edition 切替時は前 contest の entries を残さない(review claude iter 1)。
    // 大 edition → 小 edition に切り替えたときに前の集計が誤って残ると
    // 順位・スコア表示が矛盾する。null にして既存 loading gate に委ねる。
    setEntries(null)
    let canceled = false
    const contestId = selectedContest.id
    const load = async () => {
      try {
        const data = await api.getContestScoreboard(contestId)
        if (!canceled) {
          setEntries(data)
          setError(null)
        }
      } catch {
        if (!canceled) setError("スコアボードの取得に失敗しました。")
      }
    }
    load()
    const id = setInterval(load, POLL_MILLIS)
    return () => {
      canceled = true
      clearInterval(id)
    }
  }, [selectedContest])

  if (error !== null) {
    return (
      <p role="alert" className="error-page">
        {error}
      </p>
    )
  }

  if (contests === null || entries === null) {
    return <p className="loading">Loading...</p>
  }

  if (contests.length === 0) {
    return <p className="empty">開催履歴はまだありません。</p>
  }

  const sorted = [...entries].sort((a, b) => (b.bestScore ?? -1) - (a.bestScore ?? -1))

  return (
    <div>
      <div className="scoreboard-header">
        <h1>Scoreboard</h1>
        {contests.length > 1 && selectedContest !== null && (
          <label className="contest-select">
            開催回:
            <select
              value={selectedContest.id}
              onChange={(e) => {
                setSearchParams((prev) => {
                  const next = new URLSearchParams(prev)
                  next.set("contest", e.target.value)
                  return next
                })
              }}
            >
              {contests.map((c) => (
                <option key={c.id} value={c.id}>
                  第{c.edition}回 {c.name}
                  {c.status === "running" ? "(開催中)" : c.status === "finished" ? "" : `(${c.status})`}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>チーム</th>
              <th>最新スコア</th>
              <th>最高スコア</th>
              <th>最終実行</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((entry) => (
              <tr key={entry.teamId}>
                <td>{entry.teamName}</td>
                {entry.latestScore === null ? (
                  <td className="empty-cell">-</td>
                ) : (
                  <td className="num">{entry.latestScore}</td>
                )}
                {entry.bestScore === null ? <td className="empty-cell">-</td> : <td className="num">{entry.bestScore}</td>}
                {entry.latestAt === null ? (
                  <td className="empty-cell">-</td>
                ) : (
                  <td className="num">{formatDate(entry.latestAt)}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
