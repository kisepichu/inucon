import { useEffect, useState } from "react"
import type { ScoreboardEntry } from "shared/schemas"
import { api } from "../api.ts"

const POLL_MILLIS = 10_000

const formatDate = (millis: number | null) => (millis === null ? "-" : new Date(millis).toLocaleString())

export function Scoreboard() {
  const [entries, setEntries] = useState<Array<ScoreboardEntry> | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let canceled = false
    const load = async () => {
      try {
        const data = await api.getScoreboard()
        if (!canceled) {
          setEntries(data)
          setError(null)
        }
      } catch {
        if (!canceled) {
          setError("スコアボードの取得に失敗しました。")
        }
      }
    }
    load()
    const id = setInterval(load, POLL_MILLIS)
    return () => {
      canceled = true
      clearInterval(id)
    }
  }, [])

  if (error !== null) {
    return (
      <p role="alert" className="error">
        {error}
      </p>
    )
  }

  if (entries === null) {
    return <p>Loading...</p>
  }

  const sorted = [...entries].sort((a, b) => (b.bestScore ?? -1) - (a.bestScore ?? -1))

  return (
    <div>
      <h1>Scoreboard</h1>
      <table>
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
              <td>{entry.latestScore ?? "-"}</td>
              <td>{entry.bestScore ?? "-"}</td>
              <td>{formatDate(entry.latestAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
