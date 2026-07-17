import { useCallback, useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import type { BenchJob, Contest, Instance, InstanceId, Me } from "shared/schemas"
import { ApiError, api } from "../api.ts"

const JOBS_POLL_MILLIS = 10_000
// インスタンスの creating/deleting は VM 操作(clone/起動/削除)完了まで
// 数十秒〜分かかるため、ジョブ履歴より短い 5 秒周期でポーリングする。
const INSTANCES_POLL_MILLIS = 5_000

const PENDING_STATUSES = new Set(["creating", "deleting"])
const ACTIVE_STATUSES = new Set(["creating", "running"])
const DELETABLE_STATUSES = new Set(["running", "failed"])

// API のエラー _tag → 画面表示用の日本語メッセージ。未知のタグはそのまま表示する。
const ERROR_MESSAGES: Record<string, string> = {
  QuotaExceeded: "インスタンス数が上限に達しています",
  ProvisionInProgress: "既に処理中のインスタンスがあります",
  InsufficientMemory: "サーバーの空きメモリが不足しています",
  DuplicateInstanceIndex: "同じ index のインスタンスが既に存在します",
  InstanceInUse: "ベンチ対象中は削除できません",
  InvalidInstanceTransition: "この状態のインスタンスは操作できません",
  Forbidden: "権限がありません",
  NotFound: "対象が見つかりません"
}

const messageForError = (err: unknown, fallback: string) =>
  err instanceof ApiError ? (ERROR_MESSAGES[err.tag] ?? err.tag) : fallback

const instanceLabel = (teamNumber: number, instance: Instance) => `inucon-team${teamNumber}-${instance.index} (${instance.privateIp})`

const formatDate = (millis: number) => new Date(millis).toLocaleString()

// 追加ボタン押下時の index: 現存する creating/running のうち最大 index + 1
// (削除済み/失敗した index は再利用してよいので集計対象に含めない)。
const nextInstanceIndex = (instances: Array<Instance>) => {
  const maxIndex = instances
    .filter((instance) => ACTIVE_STATUSES.has(instance.status))
    .reduce((max, instance) => Math.max(max, instance.index), 0)
  return maxIndex + 1
}

interface TeamProps {
  readonly me: Me
}

export function Team({ me }: TeamProps) {
  const navigate = useNavigate()
  const team = me.team

  const [instances, setInstances] = useState<Array<Instance> | null>(null)
  const [instancesError, setInstancesError] = useState<string | null>(null)
  const [jobs, setJobs] = useState<Array<BenchJob> | null>(null)
  const [contest, setContest] = useState<Contest | null>(null)

  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const [useManualTarget, setUseManualTarget] = useState(false)
  const [selectedInstanceId, setSelectedInstanceId] = useState("")
  const [manualIp, setManualIp] = useState("")
  const [manualPort, setManualPort] = useState("80")

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadInstances = useCallback(async (teamId: string, isCanceled: () => boolean) => {
    try {
      const data = await api.listTeamInstances(teamId)
      if (!isCanceled()) {
        setInstances(data)
        setInstancesError(null)
        setSelectedInstanceId((current) => (current !== "" ? current : (data[0]?.id ?? "")))
      }
    } catch (err) {
      if (!isCanceled()) {
        setInstancesError(messageForError(err, "インスタンス一覧の読み込みに失敗しました"))
      }
    }
  }, [])

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

  // 初回ロード: インスタンス一覧・コンテスト状態・ジョブ履歴。ジョブ履歴は
  // 「実行不可の理由」の判定に使うため 10 秒周期で取り直す(スコアボードと同じ)。
  useEffect(() => {
    if (team === null) {
      return
    }
    let canceled = false
    const isCanceled = () => canceled

    loadInstances(team.id, isCanceled)
    ;(async () => {
      try {
        const contestResult = await api.getContest()
        if (!canceled) {
          setContest(contestResult)
        }
      } catch {
        if (!canceled) {
          setContest(null)
        }
      }
    })()

    loadJobs(team.id, isCanceled)
    const id = setInterval(() => loadJobs(team.id, isCanceled), JOBS_POLL_MILLIS)
    return () => {
      canceled = true
      clearInterval(id)
    }
  }, [team, loadInstances, loadJobs])

  // インスタンスに creating/deleting がある間だけ 5 秒周期でポーリングする。
  // 該当行が無くなったら(このエフェクトの再実行時に)クリアして止まる。
  useEffect(() => {
    if (team === null || instances === null) {
      return
    }
    const hasPending = instances.some((instance) => PENDING_STATUSES.has(instance.status))
    if (!hasPending) {
      return
    }
    let canceled = false
    const id = setInterval(() => loadInstances(team.id, () => canceled), INSTANCES_POLL_MILLIS)
    return () => {
      canceled = true
      clearInterval(id)
    }
  }, [team, instances, loadInstances])

  if (team === null) {
    return <p>チームに所属していません。管理者に問い合わせてください。</p>
  }

  const instanceList = instances ?? []
  const activeCount = instanceList.filter((instance) => ACTIVE_STATUSES.has(instance.status)).length
  const hasPendingOp = instanceList.some((instance) => PENDING_STATUSES.has(instance.status))
  const contestRunning = contest?.status === "running"

  const addDisabledReason = !contestRunning
    ? "コンテストが開催されていません"
    : contest !== null && activeCount >= contest.instanceQuota
      ? "インスタンス数が上限に達しています"
      : hasPendingOp
        ? "処理中のインスタンスがあります"
        : null

  const handleAddInstance = async () => {
    setAddError(null)
    setAdding(true)
    try {
      await api.createTeamInstance(team.id, { index: nextInstanceIndex(instanceList) })
      await loadInstances(team.id, () => false)
    } catch (err) {
      setAddError(messageForError(err, "追加に失敗しました"))
    } finally {
      setAdding(false)
    }
  }

  const handleDeleteInstance = async (instance: Instance) => {
    if (!window.confirm(`${instanceLabel(team.teamNumber, instance)} を削除しますか?`)) {
      return
    }
    setDeleteError(null)
    setDeletingId(instance.id)
    try {
      await api.deleteTeamInstance(team.id, instance.id)
      await loadInstances(team.id, () => false)
    } catch (err) {
      setDeleteError(messageForError(err, "削除に失敗しました"))
    } finally {
      setDeletingId(null)
    }
  }

  const hasActiveJob = jobs?.some((job) => job.status === "queued" || job.status === "running") ?? false
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
        {instancesError !== null && (
          <p role="alert" className="error">
            {instancesError}
          </p>
        )}
        <table>
          <thead>
            <tr>
              <th>名前</th>
              <th>状態</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {instanceList.map((instance) => (
              <tr key={instance.id}>
                <td>{instanceLabel(team.teamNumber, instance)}</td>
                <td>
                  <span className={`status-badge status-${instance.status}`}>{instance.status}</span>
                  {instance.errorMessage !== null && <p className="error instance-error">{instance.errorMessage}</p>}
                </td>
                <td>
                  <button
                    type="button"
                    disabled={!DELETABLE_STATUSES.has(instance.status) || deletingId === instance.id}
                    onClick={() => handleDeleteInstance(instance)}
                  >
                    削除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" onClick={handleAddInstance} disabled={adding || addDisabledReason !== null}>
          インスタンス追加
        </button>
        {addDisabledReason !== null && <p>{addDisabledReason}</p>}
        {addError !== null && (
          <p role="alert" className="error">
            {addError}
          </p>
        )}
        {deleteError !== null && (
          <p role="alert" className="error">
            {deleteError}
          </p>
        )}
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
              {instanceList.map((instance) => (
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
              <tr
                key={job.id}
                className="clickable"
                tabIndex={0}
                role="link"
                aria-label={`ジョブ詳細: ${job.id}`}
                onClick={() => navigate(`/jobs/${job.id}`)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    navigate(`/jobs/${job.id}`)
                  }
                }}
              >
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
