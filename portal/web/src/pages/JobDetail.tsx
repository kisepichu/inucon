import { useEffect, useState } from "react"
import { useParams } from "react-router-dom"
import type { BenchJobDetail } from "shared/schemas"
import { ApiError, api } from "../api.ts"

const POLL_MILLIS = 5_000

export function JobDetail() {
  const { id } = useParams<{ id: string }>()
  const [job, setJob] = useState<BenchJobDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (id === undefined) {
      return
    }
    let canceled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const load = async () => {
      try {
        const data = await api.getBenchJob(id)
        if (canceled) {
          return
        }
        setJob(data)
        setError(null)
        // queued/running の間だけ 5 秒ポーリング(スペック §7)。
        if (data.status === "queued" || data.status === "running") {
          timer = setTimeout(load, POLL_MILLIS)
        }
      } catch (err) {
        if (!canceled) {
          setError(err instanceof ApiError ? err.tag : "ジョブの取得に失敗しました")
        }
      }
    }

    load()
    return () => {
      canceled = true
      if (timer !== undefined) {
        clearTimeout(timer)
      }
    }
  }, [id])

  if (error !== null) {
    return (
      <p role="alert" className="error-page">
        {error}
      </p>
    )
  }

  if (job === null) {
    return <p className="loading">Loading...</p>
  }

  const isPolling = job.status === "queued" || job.status === "running"

  return (
    <div>
      <h1>ジョブ詳細</h1>
      <dl className="detail-dl">
        <dt>状態</dt>
        <dd>
          <span
            className={job.status === "running" ? "status-badge job-status status-running" : `status-badge status-${job.status}`}
          >
            {job.status}
          </span>
        </dd>
        <dt>スコア</dt>
        {job.score === null ? <dd className="empty-cell">-</dd> : <dd className="num mono">{job.score}</dd>}
        <dt>エラー</dt>
        {job.errorMessage === null ? <dd className="empty-cell">-</dd> : <dd>{job.errorMessage}</dd>}
      </dl>
      <div className="log-header">
        <h2>ログ</h2>
        {isPolling && <span className="live-indicator">live</span>}
      </div>
      <pre className="log-block">{job.log}</pre>
    </div>
  )
}
