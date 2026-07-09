import { useCallback, useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import type { BenchJob, Contest, Instance, InstanceId, Me } from "shared/schemas"
import { ApiError, api } from "../api.ts"

const JOBS_POLL_MILLIS = 10_000

const instanceLabel = (teamNumber: number, instance: Instance) => `inucon-team${teamNumber}-${instance.index} (${instance.privateIp})`

const formatDate = (millis: number) => new Date(millis).toLocaleString()

interface TeamProps {
  readonly me: Me
}

export function Team({ me }: TeamProps) {
  const navigate = useNavigate()
  const team = me.team

  const [instances, setInstances] = useState<Array<Instance> | null>(null)
  const [jobs, setJobs] = useState<Array<BenchJob> | null>(null)
  const [contest, setContest] = useState<Contest | null>(null)

  const [useManualTarget, setUseManualTarget] = useState(false)
  const [selectedInstanceId, setSelectedInstanceId] = useState("")
  const [manualIp, setManualIp] = useState("")
  const [manualPort, setManualPort] = useState("80")

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadJobs = useCallback(async (teamId: string, isCanceled: () => boolean) => {
    try {
      const data = await api.listBenchJobs(teamId)
      if (!isCanceled()) {
        setJobs(data)
        setError(null)
      }
    } catch (err) {
      if (!isCanceled()) {
        setError(err instanceof ApiError ? err.tag : "ジョブ履歴の読み込みに失敗しました")
      }
    }
  }, [])

  // インスタンス一覧・コンテスト状態は 1 回取得。ジョブ履歴は「実行不可の理由」の
  // 判定に使うため定期的に取り直す(スコアボードと同じ 10 秒周期)。
  useEffect(() => {
    if (team === null) {
      return
    }
    let canceled = false
    const isCanceled = () => canceled

    ;(async () => {
      try {
        const [instanceList, contestResult] = await Promise.all([
          api.listTeamInstances(team.id),
          api.getContest().catch(() => null)
        ])
        if (canceled) {
          return
        }
        setInstances(instanceList)
        setContest(contestResult)
        if (instanceList.length > 0) {
          setSelectedInstanceId(instanceList[0].id)
        }
      } catch {
        if (!canceled) {
          setInstances([])
        }
      }
    })()

    loadJobs(team.id, isCanceled)
    const id = setInterval(() => loadJobs(team.id, isCanceled), JOBS_POLL_MILLIS)
    return () => {
      canceled = true
      clearInterval(id)
    }
  }, [team, loadJobs])

  if (team === null) {
    return <p>チームに所属していません。管理者に問い合わせてください。</p>
  }

  const hasActiveJob = jobs?.some((job) => job.status === "queued" || job.status === "running") ?? false
  const contestRunning = contest?.status === "running"
  const disabledReason = !contestRunning
    ? "コンテストは開催されていません"
    : hasActiveJob
      ? "既に実行中のジョブがあります"
      : !useManualTarget && !selectedInstanceId
        ? "インスタンスを選択してください"
        : null

  const handleEnqueue = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      if (useManualTarget) {
        await api.enqueueBench({ targetIp: manualIp, targetPort: Number(manualPort) })
      } else {
        // select の value は plain string(ブランド無し)なので、契約の
        // InstanceId にキャストする(フロントエンドはランタイム検証をしない方針)。
        await api.enqueueBench({ instanceId: selectedInstanceId as InstanceId })
      }
      await loadJobs(team.id, () => false)
    } catch (err) {
      setError(err instanceof ApiError ? err.tag : "実行に失敗しました")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <h1>{team.name}</h1>

      <section>
        <h2>インスタンス</h2>
        <ul>
          {(instances ?? []).map((instance) => <li key={instance.id}>{instanceLabel(team.teamNumber, instance)}</li>)}
        </ul>
      </section>

      <section>
        <h2>ベンチ実行</h2>
        <form onSubmit={handleEnqueue}>
          <label>
            <input
              type="checkbox"
              checked={useManualTarget}
              onChange={(event) => setUseManualTarget(event.target.checked)}
            />
            IP:port を直接入力する
          </label>

          {useManualTarget ? (
            <div>
              <input
                placeholder="IP"
                value={manualIp}
                onChange={(event) => setManualIp(event.target.value)}
                required
              />
              <input
                placeholder="port"
                value={manualPort}
                onChange={(event) => setManualPort(event.target.value)}
                required
              />
            </div>
          ) : (
            <select value={selectedInstanceId} onChange={(event) => setSelectedInstanceId(event.target.value)}>
              {(instances ?? []).map((instance) => (
                <option key={instance.id} value={instance.id}>
                  {instanceLabel(team.teamNumber, instance)}
                </option>
              ))}
            </select>
          )}

          <button type="submit" disabled={submitting || disabledReason !== null}>
            実行
          </button>
          {disabledReason !== null && <p>{disabledReason}</p>}
          {error !== null && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </form>
      </section>

      <section>
        <h2>ジョブ履歴</h2>
        <table>
          <thead>
            <tr>
              <th>状態</th>
              <th>スコア</th>
              <th>時刻</th>
            </tr>
          </thead>
          <tbody>
            {(jobs ?? []).map((job) => (
              <tr key={job.id} className="clickable" onClick={() => navigate(`/jobs/${job.id}`)}>
                <td>{job.status}</td>
                <td>{job.score ?? "-"}</td>
                <td>{formatDate(job.enqueuedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
