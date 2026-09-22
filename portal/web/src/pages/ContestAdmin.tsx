import { useCallback, useEffect, useMemo, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import type {
  Artifact,
  ArtifactId,
  Contest,
  ContestId,
  Operation,
  ReadinessCheck,
  ReconciliationEntry,
  ReconciliationPlan,
  TeamWithMembers
} from "shared/schemas"
import { ApiError, api } from "../api.ts"
import {
  adoptRequiredHostnames,
  computeContestActions,
  contestStatusLabel,
  groupReadinessByStatus,
  isOperationTerminal,
  messageForErrorTag,
  operationKindLabel,
  operationStatusLabel,
  operationStatusVariant
} from "./contestViewModel.ts"

// Task 13: ContestAdmin console。開催回のライフサイクル操作 (Overview) と
// リソース収束 (Reconciliation) / readiness 診断 (Readiness) / 履歴 (Operations)
// / archive 検証 (Archive) を 1 ページの tab 切替で提供する。
//
// dangerous-action は必ず「影響を確認しました」チェックボックスの tick を
// 要求する。backend が受け取るのは path/expectedRevision/planDigest のみ ——
// free-form 文字列は絶対に送らない。stale (409) / ambiguous (422) / readiness
// 失敗は shared/api の TaggedError にマップされて 4xx で返ってくるので、
// contestViewModel.messageForErrorTag が翻訳する。

const OPERATIONS_POLL_MILLIS = 3000
const READINESS_POLL_MILLIS = 15_000

type TabKey = "overview" | "teams" | "readiness" | "reconciliation" | "operations" | "archive"

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "teams", label: "Teams" },
  { key: "readiness", label: "Readiness" },
  { key: "reconciliation", label: "Reconciliation" },
  { key: "operations", label: "Operations" },
  { key: "archive", label: "Archive" }
]

const formatDate = (millis: number | null) => (millis === null ? "-" : new Date(millis).toLocaleString())

const messageForError = (err: unknown, fallback: string): string =>
  err instanceof ApiError ? messageForErrorTag(err.tag) : fallback

export function ContestAdmin() {
  const params = useParams()
  const contestId = params.contestId as ContestId | undefined
  const navigate = useNavigate()
  const [contest, setContest] = useState<Contest | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tab, setTab] = useState<TabKey>("overview")

  const load = useCallback(async () => {
    if (contestId === undefined) return
    try {
      setContest(await api.getAdminContest(contestId))
      setLoadError(null)
    } catch (err) {
      setLoadError(messageForError(err, "コンテストの取得に失敗しました"))
    }
  }, [contestId])

  useEffect(() => {
    load()
  }, [load])

  if (loadError !== null) {
    return (
      <p role="alert" className="error-page">
        {loadError}
      </p>
    )
  }
  if (contestId === undefined || contest === null) {
    return <p className="loading">Loading...</p>
  }

  return (
    <div className="contest-admin">
      <header className="contest-admin-header">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => navigate("/admin/contests")}
        >
          ← 一覧
        </button>
        <h1>
          第{contest.edition}回 {contest.name}
        </h1>
        <span className={`status-badge status-${contest.status}`}>
          {contestStatusLabel[contest.status]}
        </span>
      </header>

      <div role="tablist" className="contest-admin-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={tab === t.key ? "tab active" : "tab"}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="contest-admin-panel">
        {tab === "overview" && <OverviewPanel contest={contest} onChanged={load} />}
        {tab === "teams" && <TeamsPanel contestId={contest.id as ContestId} />}
        {tab === "readiness" && <ReadinessPanel contestId={contest.id as ContestId} />}
        {tab === "reconciliation" && (
          <ReconciliationPanel contestId={contest.id as ContestId} contest={contest} />
        )}
        {tab === "operations" && <OperationsPanel contestId={contest.id as ContestId} />}
        {tab === "archive" && <ArchivePanel contestId={contest.id as ContestId} />}
      </div>
    </div>
  )
}

// ---- Confirmation checkbox ------------------------------------------------

// dangerous-action の共通 checkbox。text は「何が起きるか (VMID / hostname を
// 含む) 」の説明を受け、単純な boolean を返す。free-form 文字列は絶対に
// backend に送らない (Step 5 spec)。
function ConfirmCheckbox({
  checked,
  onChange,
  description
}: {
  readonly checked: boolean
  readonly onChange: (v: boolean) => void
  readonly description: string
}) {
  return (
    <label className="dangerous-confirm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="dangerous-confirm-body">
        <span className="dangerous-confirm-title">影響を確認しました</span>
        <span className="dangerous-confirm-desc">{description}</span>
      </span>
    </label>
  )
}

// ---- Overview -------------------------------------------------------------

function OverviewPanel({
  contest,
  onChanged
}: {
  readonly contest: Contest
  readonly onChanged: () => Promise<void>
}) {
  const navigate = useNavigate()
  const actions = useMemo(() => computeContestActions(contest), [contest])
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [lastOp, setLastOp] = useState<Operation | null>(null)

  const runOp = async (fn: () => Promise<Operation>, description: string) => {
    if (!confirm) return
    setError(null)
    setBusy(true)
    try {
      const op = await fn()
      setLastOp(op)
      setConfirm(false)
      await onChanged()
      // Operation を詳細画面へ誘導
      navigate(`/admin/operations/${op.id}`, { state: { description } })
    } catch (err) {
      setError(messageForError(err, "処理に失敗しました"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="section">
      <h2>Overview</h2>
      <dl className="detail-dl">
        <dt>ID</dt>
        <dd className="mono">{contest.id}</dd>
        <dt>問題</dt>
        <dd>
          {contest.problemKey} <span className="mono">({contest.problemRevision})</span>
        </dd>
        <dt>template VMID</dt>
        <dd className="mono">{contest.templateVmid}</dd>
        <dt>instance quota</dt>
        <dd>{contest.instanceQuota}</dd>
        <dt>開始予定</dt>
        <dd>{formatDate(contest.scheduledStartAt as unknown as number | null)}</dd>
        <dt>終了予定</dt>
        <dd>{formatDate(contest.scheduledEndAt as unknown as number | null)}</dd>
        <dt>Access 閉鎖予定</dt>
        <dd>{formatDate(contest.accessClosesAt as unknown as number | null)}</dd>
        <dt>revision</dt>
        <dd className="mono">{contest.revision}</dd>
      </dl>

      {(actions.beginPrepare || actions.startContest || actions.immediateFinish
        || actions.cancelDraft || actions.cleanup || actions.returnNormal
        || actions.rearchive) && (
        <div className="dangerous-actions">
          <ConfirmCheckbox
            checked={confirm}
            onChange={setConfirm}
            description="この操作は Contest 状態遷移と外部リソースへの副作用を伴います。開催回・revision・対象を確認してください。"
          />
          <div className="section-actions">
            {actions.beginPrepare && (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!confirm || busy}
                onClick={async () => {
                  if (!confirm) return
                  setError(null)
                  setBusy(true)
                  try {
                    await api.beginContestPreparation(contest.id, { expectedRevision: contest.revision })
                    setConfirm(false)
                    await onChanged()
                  } catch (err) {
                    setError(messageForError(err, "準備開始に失敗しました"))
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                準備開始
              </button>
            )}
            {actions.startContest && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!confirm || busy}
                aria-busy={busy}
                onClick={() =>
                  runOp(
                    () => api.requestContestStart(contest.id, { expectedRevision: contest.revision }),
                    "コンテスト開始"
                  )
                }
              >
                開始
              </button>
            )}
            {actions.immediateFinish && (
              <button
                type="button"
                className="btn btn-danger"
                disabled={!confirm || busy}
                aria-busy={busy}
                onClick={() =>
                  runOp(
                    () => api.requestContestFinalize(contest.id, { expectedRevision: contest.revision }),
                    "即時終了"
                  )
                }
              >
                即時終了
              </button>
            )}
            {actions.cancelDraft && (
              <button
                type="button"
                className="btn btn-danger"
                disabled={!confirm || busy}
                onClick={async () => {
                  if (!confirm) return
                  setError(null)
                  setBusy(true)
                  try {
                    await api.cancelAdminContest(contest.id, { expectedRevision: contest.revision })
                    setConfirm(false)
                    await onChanged()
                  } catch (err) {
                    setError(messageForError(err, "キャンセルに失敗しました"))
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                キャンセル
              </button>
            )}
            {actions.returnNormal && (
              <button
                type="button"
                className="btn btn-danger"
                disabled={!confirm || busy}
                aria-busy={busy}
                onClick={() =>
                  runOp(() => api.requestReturnNormalMode(contest.id), "通常モード復帰 (devvm 起動 / benchvm 停止)")
                }
              >
                通常モード復帰
              </button>
            )}
            {actions.rearchive && (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!confirm || busy}
                aria-busy={busy}
                onClick={() =>
                  runOp(() => api.requestContestArchive(contest.id), "archive 再生成")
                }
              >
                archive 再生成
              </button>
            )}
          </div>
        </div>
      )}

      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {lastOp !== null && (
        <p className="notice-ok">
          Operation を発行しました: <Link to={`/admin/operations/${lastOp.id}`}>{lastOp.id}</Link>
        </p>
      )}
    </section>
  )
}

// ---- Teams ----------------------------------------------------------------

function TeamsPanel({ contestId }: { readonly contestId: ContestId }) {
  const [teams, setTeams] = useState<ReadonlyArray<TeamWithMembers> | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let canceled = false
    ;(async () => {
      try {
        const data = await api.listTeams()
        // 現行 API は operational contest 前提だが、admin コンソールは編成
        // 見取り図として全 team を出す。contestId 一致でフィルタしない (Task 6+
        // の setTeamMembers は operational 前提)。UI 表示のみに使う。
        if (!canceled) {
          setTeams(data)
          setError(null)
        }
      } catch (err) {
        if (!canceled) setError(messageForError(err, "チーム一覧の取得に失敗しました"))
      }
    })()
    return () => {
      canceled = true
    }
  }, [contestId])

  if (error !== null) return <p role="alert" className="error">{error}</p>
  if (teams === null) return <p className="loading">Loading...</p>

  return (
    <section className="section">
      <h2>Teams</h2>
      {teams.length === 0 ? (
        <p className="empty-state">
          チームがありません。<Link to="/admin">Admin</Link> から作成してください。
        </p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>team</th>
                <th>desired</th>
                <th>members</th>
              </tr>
            </thead>
            <tbody>
              {teams.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td className="num">{t.desiredInstanceCount}</td>
                  <td>
                    {t.members.length === 0
                      ? <span className="empty-cell">-</span>
                      : t.members.map((m) => m.githubLogin).join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ---- Readiness ------------------------------------------------------------

function ReadinessPanel({ contestId }: { readonly contestId: ContestId }) {
  const [checks, setChecks] = useState<ReadonlyArray<ReadinessCheck> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    setRefreshing(true)
    try {
      const data = await api.getContestReadiness(contestId)
      setChecks(data)
      setError(null)
    } catch (err) {
      setError(messageForError(err, "readiness の取得に失敗しました"))
    } finally {
      setRefreshing(false)
    }
  }, [contestId])

  useEffect(() => {
    load()
    const id = setInterval(load, READINESS_POLL_MILLIS)
    return () => clearInterval(id)
  }, [load])

  if (error !== null) return <p role="alert" className="error">{error}</p>
  if (checks === null) return <p className="loading">Loading...</p>

  const grouped = groupReadinessByStatus(checks)
  const render = (group: ReadonlyArray<ReadinessCheck>) =>
    group.map((c) => (
      <li key={c.key} data-testid="readiness-item">
        <span className={`status-badge status-${c.status === "fail" ? "failed" : c.status === "warn" ? "creating" : "running"}`}>
          {c.status}
        </span>
        <span className="mono">{c.key}</span>
        <span className="readiness-summary">{c.summary}</span>
      </li>
    ))

  return (
    <section className="section">
      <div className="section-header">
        <h2>Readiness</h2>
        <button type="button" className="btn btn-secondary btn-sm" onClick={load} disabled={refreshing}>
          再診断
        </button>
      </div>
      <ul className="readiness-list">
        {render(grouped.fail)}
        {render(grouped.warn)}
        {render(grouped.pass)}
      </ul>
    </section>
  )
}

// ---- Reconciliation -------------------------------------------------------

function ReconciliationPanel({ contestId, contest }: { readonly contestId: ContestId; readonly contest: Contest }) {
  const [plan, setPlan] = useState<ReconciliationPlan | null>(null)
  const [adopted, setAdopted] = useState<Readonly<Record<string, true>>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [lastOp, setLastOp] = useState<Operation | null>(null)

  const requiredAdopt = plan === null ? [] : adoptRequiredHostnames(plan)
  const allAdopted = requiredAdopt.every((h) => adopted[h] === true)

  const runPlan = async () => {
    setError(null)
    setBusy(true)
    setLastOp(null)
    try {
      // plan 再取得時は前回の adopt チェック状態を保持しない (別の plan/revision の
      // ホスト名が残ると誤 apply の危険がある)。
      const p = await api.planReconciliation(contestId, { adoptHostnames: [] })
      setPlan(p)
      setAdopted({})
    } catch (err) {
      setError(messageForError(err, "診断に失敗しました"))
    } finally {
      setBusy(false)
    }
  }

  const runApply = async () => {
    if (plan === null || !allAdopted) return
    setError(null)
    setBusy(true)
    try {
      const op = await api.applyReconciliation(contestId, {
        planDigest: plan.planDigest,
        adoptHostnames: requiredAdopt
      })
      setLastOp(op)
      // 適用済み plan は無効化する (stale 前提)。
      setPlan(null)
    } catch (err) {
      setError(messageForError(err, "適用に失敗しました"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="section">
      <div className="section-header">
        <h2>Reconciliation</h2>
        <button type="button" className="btn btn-primary btn-sm" onClick={runPlan} disabled={busy}>
          診断
        </button>
      </div>
      <p className="hint">
        contest revision <span className="mono">{contest.revision}</span> の外部リソースを検出します。<br />
        managed_orphan は portal 所有のため自動 cleanup、unmanaged_orphan は
        hostname ごとの adopt 確認を経てから削除します。
      </p>
      {plan !== null && (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>hostname</th>
                  <th>classification</th>
                  <th>action</th>
                  <th>Proxmox</th>
                  <th>CF DNS</th>
                  <th>CF ingress</th>
                  <th>CF app</th>
                  <th>reason</th>
                </tr>
              </thead>
              <tbody>
                {plan.entries.map((e: ReconciliationEntry) => (
                  <tr key={e.hostname}>
                    <td className="mono">{e.hostname}</td>
                    <td>{e.classification}</td>
                    <td>{e.action}</td>
                    <td className="num">{e.proxmoxVmObserved ? "1" : "0"}</td>
                    <td className="num">{e.cloudflareRouteCount}</td>
                    <td className="num">{e.cloudflareIngressCount}</td>
                    <td className="num">{e.cloudflareAppCount}</td>
                    <td>{e.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {requiredAdopt.length > 0 && (
            <div className="adopt-block">
              <p className="hint">
                以下の hostname は portal 所有として adopt (合意して自動削除) してください。
                個別に確認してください。
              </p>
              {requiredAdopt.map((h) => (
                <label key={h} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={adopted[h] === true}
                    onChange={(e) =>
                      setAdopted((prev) => {
                        const next = { ...prev }
                        if (e.target.checked) next[h] = true
                        else delete next[h]
                        return next
                      })
                    }
                  />
                  <span className="mono">{h}</span>
                </label>
              ))}
            </div>
          )}
          <div className="section-actions">
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy || !allAdopted}
              onClick={runApply}
            >
              適用
            </button>
            <p className="disabled-reason mono">
              plan digest: {plan.planDigest.slice(0, 12)}…
            </p>
          </div>
        </>
      )}
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {lastOp !== null && (
        <p className="notice-ok">
          Operation を発行しました: <Link to={`/admin/operations/${lastOp.id}`}>{lastOp.id}</Link>
        </p>
      )}
    </section>
  )
}

// ---- Operations -----------------------------------------------------------

function OperationsPanel({ contestId }: { readonly contestId: ContestId }) {
  const [ops, setOps] = useState<ReadonlyArray<Operation> | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 「terminal でない Operation がある間だけ polling を続ける」フラグ。
  // succeeded/failed/canceled しか無くなったら polling を止める (Task 13 spec)。
  const [polling, setPolling] = useState(true)

  const load = useCallback(async () => {
    try {
      const data = await api.listContestOperations(contestId)
      setOps(data)
      setError(null)
      const hasLive = data.some((op) => !isOperationTerminal(op.status))
      setPolling(hasLive)
    } catch (err) {
      setError(messageForError(err, "Operation 一覧の取得に失敗しました"))
    }
  }, [contestId])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!polling) return
    const id = setInterval(load, OPERATIONS_POLL_MILLIS)
    return () => clearInterval(id)
  }, [polling, load])

  if (error !== null) return <p role="alert" className="error">{error}</p>
  if (ops === null) return <p className="loading">Loading...</p>

  return (
    <section className="section">
      <h2>Operations</h2>
      {ops.length === 0 ? (
        <p className="empty-state">Operation 履歴はまだありません。</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>kind</th>
                <th>status</th>
                <th>作成</th>
                <th>完了</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {ops.map((op) => (
                <tr key={op.id}>
                  <td>{operationKindLabel[op.kind]}</td>
                  <td>
                    <span className={`status-badge status-${operationStatusVariant(op.status)}`}>
                      {operationStatusLabel[op.status]}
                    </span>
                  </td>
                  <td className="num">{formatDate(op.createdAt)}</td>
                  <td className="num">{formatDate(op.finishedAt as number | null)}</td>
                  <td>
                    <Link to={`/admin/operations/${op.id}`}>詳細</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ---- Archive --------------------------------------------------------------

function ArchivePanel({ contestId }: { readonly contestId: ContestId }) {
  const [artifacts, setArtifacts] = useState<ReadonlyArray<Artifact> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [verifyInputs, setVerifyInputs] = useState<Readonly<Record<string, string>>>({})
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setArtifacts(await api.listContestArtifacts(contestId))
      setError(null)
    } catch (err) {
      setError(messageForError(err, "artifact 一覧の取得に失敗しました"))
    }
  }, [contestId])

  useEffect(() => {
    load()
  }, [load])

  const verify = async (id: ArtifactId) => {
    const sha = verifyInputs[id]
    if (sha === undefined || sha.length === 0) return
    setBusy(true)
    setError(null)
    try {
      await api.verifyArtifactChecksum(id, { sha256: sha })
      await load()
    } catch (err) {
      setError(messageForError(err, "SHA-256 の再入力に失敗しました"))
    } finally {
      setBusy(false)
    }
  }

  if (error !== null && artifacts === null)
    return <p role="alert" className="error">{error}</p>
  if (artifacts === null) return <p className="loading">Loading...</p>

  return (
    <section className="section">
      <h2>Archive</h2>
      {artifacts.length === 0 ? (
        <p className="empty-state">Artifact はまだありません。Contest が finish するまで生成されません。</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>kind</th>
                <th>size</th>
                <th>SHA-256</th>
                <th>off-host</th>
                <th>download</th>
                <th>verify</th>
              </tr>
            </thead>
            <tbody>
              {artifacts.map((a) => (
                <tr key={a.id}>
                  <td>{a.kind}</td>
                  <td className="num">{a.sizeBytes}</td>
                  <td className="mono">{a.sha256.slice(0, 12)}…</td>
                  <td>{a.offHostStatus}</td>
                  <td>
                    <a
                      href={
                        a.kind === "snapshot"
                          ? `/api/admin/artifacts/${a.id}/download`
                          : `/api/artifacts/${a.id}/download`
                      }
                    >
                      download
                    </a>
                  </td>
                  <td>
                    {a.offHostStatus === "pending" ? (
                      <div className="artifact-verify">
                        <label htmlFor={`sha-${a.id}`} className="visually-hidden">SHA-256</label>
                        <input
                          id={`sha-${a.id}`}
                          className="input"
                          aria-label="SHA-256"
                          placeholder="64 桁 hex を再入力"
                          value={verifyInputs[a.id] ?? ""}
                          onChange={(e) =>
                            setVerifyInputs((prev) => ({ ...prev, [a.id]: e.target.value }))
                          }
                        />
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={busy}
                          onClick={() => verify(a.id as ArtifactId)}
                        >
                          off-host verify
                        </button>
                      </div>
                    ) : (
                      <span className="empty-cell">-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  )
}
