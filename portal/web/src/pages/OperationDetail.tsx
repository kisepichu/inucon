import { useCallback, useEffect, useState } from "react"
import { Link, useLocation, useParams } from "react-router-dom"
import type { OperationId, OperationWithSteps } from "shared/schemas"
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

  if (error !== null) return <p role="alert" className="error-page">{error}</p>
  if (operationId === undefined) return <p className="loading">不正な Operation ID です</p>
  if (op === null) return <p className="loading">Loading...</p>

  const terminal = isOperationTerminal(op.status)

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
    </div>
  )
}
