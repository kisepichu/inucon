import { useCallback, useEffect, useState } from "react"
import { Link, useLocation, useParams } from "react-router-dom"
import type { Contest, OperationId, OperationStatus, OperationWithSteps } from "shared/schemas"
import { ApiError, api } from "../api.ts"
import {
  isOperationTerminal,
  messageForErrorTag,
  operationKindLabel,
  operationStatusLabel,
  operationStatusVariant
} from "./contestViewModel.ts"

// Task 13: durable Operation の詳細画面。step / attempt / sanitized error を
// ordinal 昇順で表示し、terminal 状態 (succeeded / failed / canceled) に落ちるまで
// 3 秒間隔で poll する。sanitized_error は SanitizedOperationError schema で
// validate 済みの code / summary / details のみを表示 (生 email / bearer / cause は
// backend が既に落としている)。
//
// queued / failed / blocked の Operation は確認 checkbox 付きで cancel できる。
// cancel できる status は domain の cancelOperation と同じ集合で、最終判定は
// backend (OperationRepo.cancel) が行う。ここはボタンの出し分けにだけ使う。
const CANCELABLE: ReadonlyArray<OperationStatus> = ["queued", "failed", "blocked"]

const POLL_MILLIS = 3000

const formatDate = (millis: number | null) => (millis === null ? "-" : new Date(millis).toLocaleString())

interface RouteState {
  readonly description?: string
}

export function OperationDetail() {
  const params = useParams()
  const location = useLocation()
  const operationId = params.operationId as OperationId | undefined
  const state = location.state as RouteState | null

  const [op, setOp] = useState<OperationWithSteps | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [contest, setContest] = useState<Contest | null>(null)
  // 確認 checkbox は「どの status を見て確認したか」を持つ。polling で status が
  // 変わったら確認は自動的に外れ、古い状態への確認で cancel させない。
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null)
  const [canceling, setCanceling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (operationId === undefined) return
    try {
      const data = await api.getAdminOperation(operationId)
      setOp(data)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? messageForErrorTag(err.tag) : "Operation の取得に失敗しました")
    }
  }, [operationId])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (op === null || isOperationTerminal(op.status)) return
    const id = setInterval(load, POLL_MILLIS)
    return () => clearInterval(id)
  }, [op, load])

  // 確認画面に対象 Contest の名前を出すためだけに読む。取れなければ ID だけ出す。
  const contestId = op?.contestId
  useEffect(() => {
    if (contestId === undefined) return
    api.getAdminContest(contestId).then(setContest, () => setContest(null))
  }, [contestId])

  if (error !== null) return <p role="alert" className="error-page">{error}</p>
  if (operationId === undefined) return <p className="loading">不正な Operation ID です</p>
  if (op === null) return <p className="loading">Loading...</p>

  const terminal = isOperationTerminal(op.status)
  const statusKey = `${op.id}:${op.status}`
  const confirmed = confirmedFor === statusKey
  const pendingSteps = op.steps.filter((s) => s.status !== "succeeded")

  const cancel = async () => {
    if (!confirmed) return
    setCancelError(null)
    setCanceling(true)
    try {
      await api.cancelAdminOperation(op.id)
    } catch (err) {
      setCancelError(
        err instanceof ApiError && err.tag === "InvalidOperationTransition"
          ? "Operation の状態が変わったため cancel できませんでした。最新の状態を表示しています。"
          : err instanceof ApiError
            ? messageForErrorTag(err.tag)
            : "cancel に失敗しました"
      )
    } finally {
      setCanceling(false)
    }
    // 成功でも 409 でも status / steps を取り直して表示を揃える。
    await load()
  }

  return (
    <div className="operation-detail">
      <header className="operation-detail-header">
        <Link to={`/admin/contests/${op.contestId}`} className="btn btn-secondary btn-sm">
          ← Contest
        </Link>
        <h1>{operationKindLabel[op.kind]}</h1>
        <span className={`status-badge status-${operationStatusVariant(op.status)}`}>
          {operationStatusLabel[op.status]}
        </span>
        {!terminal && <span className="live-indicator">live</span>}
      </header>

      {state?.description !== undefined && (
        <p className="hint">{state.description}</p>
      )}

      <dl className="detail-dl">
        <dt>ID</dt>
        <dd className="mono">{op.id}</dd>
        <dt>plan digest</dt>
        <dd className="mono">{op.planDigest}</dd>
        <dt>Contest revision</dt>
        <dd className="mono">{op.contestRevision}</dd>
        <dt>actor</dt>
        <dd>{op.actor.kind === "admin" ? `admin (${op.actor.userId})` : "scheduler"}</dd>
        <dt>作成</dt>
        <dd className="num">{formatDate(op.createdAt)}</dd>
        <dt>開始</dt>
        <dd className="num">{formatDate(op.startedAt as number | null)}</dd>
        <dt>終了</dt>
        <dd className="num">{formatDate(op.finishedAt as number | null)}</dd>
      </dl>

      {op.sanitizedError !== null && (
        <div className="operation-error">
          <h2>error</h2>
          <p>
            <span className="mono">{op.sanitizedError.code}</span> — {op.sanitizedError.summary}
          </p>
          {Object.keys(op.sanitizedError.details).length > 0 && (
            <dl className="detail-dl">
              {Object.entries(op.sanitizedError.details).map(([k, v]) => (
                <div key={k}>
                  <dt className="mono">{k}</dt>
                  <dd className="mono">{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}

      <h2>Steps</h2>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>#</th>
              <th>step</th>
              <th>status</th>
              <th>attempt</th>
              <th>continueOnError</th>
              <th>result / error</th>
              <th>開始</th>
              <th>終了</th>
            </tr>
          </thead>
          <tbody>
            {op.steps.map((s) => (
              <tr key={s.id}>
                <td className="num">{s.ordinal}</td>
                <td className="mono">{s.stepKey}</td>
                <td>
                  <span className={`status-badge status-${operationStatusVariant(s.status)}`}>
                    {operationStatusLabel[s.status]}
                  </span>
                </td>
                <td className="num">{s.attempt}</td>
                <td>{s.continueOnError ? "yes" : "no"}</td>
                <td>
                  {s.sanitizedError !== null ? (
                    <span className="mono">
                      {s.sanitizedError.code} — {s.sanitizedError.summary}
                    </span>
                  ) : s.resultSummary !== null ? (
                    <span>{s.resultSummary as string}</span>
                  ) : (
                    <span className="empty-cell">-</span>
                  )}
                </td>
                <td className="num">{formatDate(s.startedAt as number | null)}</td>
                <td className="num">{formatDate(s.finishedAt as number | null)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {CANCELABLE.includes(op.status) && (
        <section className="dangerous-actions" aria-labelledby="operation-cancel-heading">
          <h2 id="operation-cancel-heading">Operation の cancel</h2>
          <dl className="detail-dl">
            <dt>Operation</dt>
            <dd>
              {operationKindLabel[op.kind]} <span className="mono">({op.kind})</span>
            </dd>
            <dt>対象 Contest</dt>
            <dd>
              {contest !== null && `${contest.name} (第 ${contest.edition} 回) `}
              <span className="mono">{op.contestId}</span>
            </dd>
          </dl>
          <p>未完了の step ({pendingSteps.length} 件):</p>
          <ul>
            {pendingSteps.map((s) => (
              <li key={s.id} data-testid="cancel-pending-step">
                <span className="mono">{s.stepKey}</span> — {operationStatusLabel[s.status]}
                {s.status === "queued" && " (実行されずに failed (canceled) で閉じる)"}
              </li>
            ))}
          </ul>
          <p className="hint">
            cancel すると Operation は canceled になり、global lock が外れて次の Operation を enqueue
            できるようになります。queued の step は実行されません。
            <strong>
              実行済みの step が作成・変更・停止した外部 resource (Proxmox VM の作成・電源・onboot、Cloudflare DNS /
              Access / tunnel ingress) は巻き戻しません。
            </strong>
            続きが必要なら、cancel 後に Operation を改めてリクエストしてください。
          </p>
          <label className="dangerous-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={canceling}
              onChange={(e) => setConfirmedFor(e.target.checked ? statusKey : null)}
            />
            <span className="dangerous-confirm-body">
              <span className="dangerous-confirm-title">影響を確認しました</span>
              <span className="dangerous-confirm-desc">上記の Operation を canceled にします。元に戻せません。</span>
            </span>
          </label>
          <div className="section-actions">
            <button
              type="button"
              className="btn btn-danger"
              disabled={!confirmed || canceling}
              aria-busy={canceling}
              onClick={cancel}
            >
              Operation を cancel
            </button>
          </div>
        </section>
      )}
      {op.status === "running" && (
        <p className="disabled-reason">
          実行中 (running) の Operation は cancel できません。worker が step を進め、Operation が blocked /
          failed に落ちる (または succeeded で終わる) と cancel できるようになります。portal の再起動などで
          lease が切れても、worker が同じ step を再実行するだけで Operation は running のままです。
        </p>
      )}
      {cancelError !== null && (
        <p role="alert" className="error">
          {cancelError}
        </p>
      )}
    </div>
  )
}
