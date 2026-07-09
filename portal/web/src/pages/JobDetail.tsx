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
      <p role="alert" className="error">
        {error}
      </p>
    )
  }

  if (job === null) {
    return <p>Loading...</p>
  }

  return (
    <div>
      <h1>ジョブ詳細</h1>
      <dl>
        <dt>状態</dt>
        <dd>{job.status}</dd>
        <dt>スコア</dt>
        <dd>{job.score ?? "-"}</dd>
        <dt>エラー</dt>
        <dd>{job.errorMessage ?? "-"}</dd>
      </dl>
      <h2>ログ</h2>
      <pre>{job.log}</pre>
    </div>
  )
}
