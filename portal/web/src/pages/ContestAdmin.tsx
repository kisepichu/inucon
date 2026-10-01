import { type ReactNode, useCallback, useEffect, useId, useMemo, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import type {
  Artifact,
  ArtifactId,
  BenchJob,
  Contest,
  ContestId,
  Operation,
  PreparationPlan,
  ReadinessCheck,
  ReconciliationEntry,
  ReconciliationPlan,
  TeamWithMembers
} from "shared/schemas"
import { ApiError, api } from "../api.ts"
import {
  adoptRequiredHostnames,
  blockedHostnames,
  cleanupTargetEntries,
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

// 1 操作分の「影響対象 (children) + 専用の確認 checkbox + 実行ボタン」。checkbox を
// 操作ごとに持たせ、別の操作の確認で押せる状態にしない (plan Task 13 Step 5:
// mode switch 等は影響する hostname / VMID を示して確認を要求する)。確認は tick した
// 時点の resetKey (= 確認した対象) に紐づき、resetKey が変わると未確認に戻る。
function ConfirmedAction({
  title,
  confirmDescription,
  buttonLabel,
  buttonClassName,
  disabledReason,
  resetKey,
  busy,
  onRun,
  children
}: {
  readonly title: string
  readonly confirmDescription: string
  readonly buttonLabel: string
  readonly buttonClassName: string
  readonly disabledReason: string | null
  readonly resetKey?: string
  readonly busy: boolean
  readonly onRun: () => Promise<void>
  readonly children?: ReactNode
}) {
  const headingId = useId()
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null)
  const key = resetKey ?? ""
  const confirmed = confirmedKey === key
  const runnable = confirmed && disabledReason === null
  return (
    <section className="dangerous-actions" aria-labelledby={headingId}>
      <h3 id={headingId}>{title}</h3>
      {children}
      <ConfirmCheckbox
        checked={confirmed}
        onChange={(v) => setConfirmedKey(v ? key : null)}
        description={confirmDescription}
      />
      <div className="section-actions">
        <button
          type="button"
          className={`btn ${buttonClassName}`}
          disabled={!runnable || busy}
          aria-busy={busy}
          onClick={() => {
            if (runnable) void onRun()
          }}
        >
          {buttonLabel}
        </button>
        {disabledReason !== null && <p className="disabled-reason">{disabledReason}</p>}
      </div>
    </section>
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
  // 競技モード切替 / インスタンス準備の影響対象。VMID や hostname の導出は web に
  // 持たず server (GET /preparation-plan) が返したものだけを表示する。取れないうちは
  // 確認させようがないのでボタンを出さない。
  const needsPlan = actions.enterContestMode || actions.prepareInstances || actions.rehearsal
  const [plan, setPlan] = useState<PreparationPlan | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)

  useEffect(() => {
    if (!needsPlan) return
    let canceled = false
    ;(async () => {
      try {
        const p = await api.getPreparationPlan(contest.id)
        if (!canceled) {
          setPlan(p)
          setPlanError(null)
        }
      } catch (err) {
        if (!canceled) setPlanError(messageForError(err, "影響対象の取得に失敗しました"))
      }
    })()
    return () => {
      canceled = true
    }
  }, [needsPlan, contest.id, contest.revision])

  // Operation を積んで詳細画面へ誘導する。確認 checkbox は呼び出し側で判定済み。
  const submitOp = async (fn: () => Promise<Operation>, description: string) => {
    setError(null)
    setBusy(true)
    try {
      const op = await fn()
      setLastOp(op)
      setConfirm(false)
      await onChanged()
      navigate(`/admin/operations/${op.id}`, { state: { description } })
    } catch (err) {
      setError(messageForError(err, "処理に失敗しました"))
    } finally {
      setBusy(false)
    }
  }

  // ライフサイクル操作 (共通 checkbox) 用。
  const runOp = async (fn: () => Promise<Operation>, description: string) => {
    if (!confirm) return
    await submitOp(fn, description)
  }

  const toCreate = plan?.instanceSlots.filter((s) => s.instanceStatus === null) ?? []
  const existing = plan?.instanceSlots.filter((s) => s.instanceStatus !== null) ?? []

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

      {/* spec の流れ: 準備開始 (§3 preflight) → 競技モード切替 (§3) → インスタンス準備 (§4)
          → rehearsal → 開始 (§5)。各操作は対象の Contest.status でだけ出る。 */}
      {actions.beginPrepare && (
        <ConfirmedAction
          title="準備開始"
          buttonLabel="準備開始"
          buttonClassName="btn-secondary"
          confirmDescription={`第${contest.edition}回 (revision ${contest.revision}) を draft から preparing に遷移します。外部リソースは変更しません。`}
          disabledReason={null}
          busy={busy}
          onRun={async () => {
            setError(null)
            setBusy(true)
            try {
              await api.beginContestPreparation(contest.id, { expectedRevision: contest.revision })
              await onChanged()
            } catch (err) {
              setError(messageForError(err, "準備開始に失敗しました"))
            } finally {
              setBusy(false)
            }
          }}
        />
      )}

      {needsPlan && planError !== null && (
        <p role="alert" className="error">
          影響対象 (VM / hostname) を取得できないため、競技モード切替 / インスタンス準備 / rehearsal は実行できません: {planError}
        </p>
      )}
      {needsPlan && plan === null && planError === null && <p className="loading">影響対象を取得しています...</p>}

      {actions.enterContestMode && plan !== null && (
        <ConfirmedAction
          title="競技モード切替"
          buttonLabel="競技モード切替"
          buttonClassName="btn-danger"
          confirmDescription={`${plan.contestMode.shutdownVm.name} (VMID ${plan.contestMode.shutdownVm.vmid}) を停止し、${plan.contestMode.startVm.name} (VMID ${plan.contestMode.startVm.vmid}) を起動します。停止中は ${plan.contestMode.shutdownVm.name} 上のサービスを使えません。`}
          disabledReason={null}
          busy={busy}
          onRun={() => submitOp(() => api.requestEnterContestMode(contest.id), "競技モード切替")}
        >
          <ul>
            <li data-testid="mode-shutdown">
              <span className="mono">{plan.contestMode.shutdownVm.name}</span> (VMID{" "}
              <span className="mono">{plan.contestMode.shutdownVm.vmid}</span>): onboot=0 → guest shutdown
              (force stop はしない) → 停止を待つ
            </li>
            <li data-testid="mode-start">
              <span className="mono">{plan.contestMode.startVm.name}</span> (VMID{" "}
              <span className="mono">{plan.contestMode.startVm.vmid}</span>): 空きメモリを確認 → onboot=1 → 起動
            </li>
          </ul>
          <p className="hint">
            shutdown が時間内に終わらなければ Operation は blocked で止まります (contest-recovery runbook §5)。
          </p>
        </ConfirmedAction>
      )}

      {actions.prepareInstances && plan !== null && (
        <ConfirmedAction
          title="インスタンス準備"
          buttonLabel="インスタンス準備"
          buttonClassName="btn-primary"
          confirmDescription={`上記 ${toCreate.length} 台の VM を 1 台ずつ作成し、Cloudflare DNS / tunnel ingress / Access application を設定します。`}
          disabledReason={toCreate.length === 0 ? "作成予定の Instance がありません" : null}
          busy={busy}
          onRun={() => submitOp(() => api.requestPrepareInstances(contest.id), "インスタンス準備")}
        >
          <p className="hint">競技モード切替が完了している (VM の停止 / 起動が済んでいる) ことが前提です。</p>
          <p>{`作成予定 ${toCreate.length} 台`}</p>
          {toCreate.length > 0 && (
            <ul>
              {toCreate.map((s) => (
                <li key={s.hostname} data-testid="prepare-create">
                  <span className="mono">{s.hostname}</span> — VMID <span className="mono">{s.vmid}</span>
                </li>
              ))}
            </ul>
          )}
          {existing.length > 0 && (
            <>
              <p className="hint">既に Instance がある枠は作り直しません:</p>
              <ul>
                {existing.map((s) => (
                  <li key={s.hostname} data-testid="prepare-existing">
                    <span className="mono">{s.hostname}</span> — VMID <span className="mono">{s.vmid}</span> —{" "}
                    {s.instanceStatus}
                  </li>
                ))}
              </ul>
            </>
          )}
          {existing.some((s) => s.instanceStatus === "failed") && (
            <p className="disabled-reason">
              failed の枠があるため、作成後も全台 running にならず Operation は blocked で止まります。
            </p>
          )}
        </ConfirmedAction>
      )}

      {actions.rehearsal && plan !== null && <RehearsalAction contestId={contest.id} plan={plan} />}

      {(actions.startContest || actions.immediateFinish
        || actions.cancelDraft || actions.returnNormal || actions.rearchive) && (
        <section className="dangerous-actions" aria-label="ライフサイクル操作">
          <ConfirmCheckbox
            checked={confirm}
            onChange={setConfirm}
            description="この操作は Contest 状態遷移と外部リソースへの副作用を伴います。開催回・revision・対象を確認してください。"
          />
          <div className="section-actions">
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
        </section>
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

// ---- Rehearsal ------------------------------------------------------------

// spec の流れでインスタンス準備と開始の間に置く。readiness `rehearsal` (start の必須項目) は
// この Contest で purpose=rehearsal・status=finished・passed=true の job が 1 件以上あるときだけ
// pass になり、score は見ない。対象は preparation-plan の running 枠だけ (backend の
// enqueueRehearsal も running 以外は RehearsalInstanceNotRunning で拒否する)。結果は既存の
// job 詳細 (/jobs/:id。queued / running の間は polling し、判定 / score / ログを出す) で見る。
function RehearsalAction({ contestId, plan }: { readonly contestId: ContestId; readonly plan: PreparationPlan }) {
  const selectId = useId()
  const targets = plan.instanceSlots.flatMap((s) =>
    s.instanceStatus === "running" && s.instanceId !== null ? [{ ...s, instanceId: s.instanceId }] : []
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const target = targets.find((s) => s.instanceId === selectedId) ?? targets[0] ?? null
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [job, setJob] = useState<BenchJob | null>(null)

  return (
    <ConfirmedAction
      title="rehearsal"
      buttonLabel="rehearsal 実行"
      buttonClassName="btn-primary"
      confirmDescription={
        target === null
          ? "rehearsal の対象にできる Instance がありません。"
          : `${target.hostname} (VMID ${target.vmid}) にベンチマーカーを 1 回流し、実際に負荷をかけます。`
      }
      disabledReason={target === null ? "running の Instance がありません。先にインスタンス準備を完了させてください" : null}
      // 対象を変えたら確認し直させる。投入した job が変わったら (= 次の実行は次の負荷) も同じ。
      resetKey={`${target?.instanceId ?? ""}/${job?.id ?? ""}`}
      busy={busy}
      onRun={async () => {
        if (target === null) return
        setError(null)
        setBusy(true)
        try {
          setJob(await api.enqueueRehearsal(contestId, { instanceId: target.instanceId }))
        } catch (err) {
          setError(messageForError(err, "rehearsal の投入に失敗しました"))
        } finally {
          setBusy(false)
        }
      }}
    >
      <p className="hint">
        readiness の rehearsal (開始の必須項目) は、この開催回で finished かつ判定 pass の rehearsal job が 1 件以上
        あると pass になります (score は問いません)。
      </p>
      {targets.length > 0 && (
        <div className="form-field">
          <label htmlFor={selectId}>対象 Instance</label>
          <select
            id={selectId}
            className="input"
            value={target?.instanceId ?? ""}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            {targets.map((s) => (
              <option key={s.instanceId} value={s.instanceId}>
                {`${s.hostname} — VMID ${s.vmid} (${s.teamName})`}
              </option>
            ))}
          </select>
        </div>
      )}
      {job !== null && (
        <p className="notice-ok">
          rehearsal job を投入しました: <Link to={`/jobs/${job.id}`}>{job.id}</Link> (状態・判定・score・ログを表示します)
        </p>
      )}
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </ConfirmedAction>
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

// plan の digest は (inventory, adoptHostnames) の関数で、server は apply / cleanup
// のたびに plan を再計算して digest を照合する。apply は送られた adoptHostnames で、
// cleanup は adoptHostnames=[] で再計算するので、それぞれ「同じ adoptHostnames で
// 取った plan」の digest しか通らない。adopt すると unmanaged_orphan の action が
// blocked → adopt_cleanup に変わるため、adopt=[] で取った digest を adopt 付き
// apply に流用すると必ず StaleReconciliationPlan になる。
function ReconciliationPanel({ contestId, contest }: { readonly contestId: ContestId; readonly contest: Contest }) {
  const actions = useMemo(() => computeContestActions(contest), [contest])
  // 「診断」で取る adoptHostnames=[] の plan。cleanup の対象表示と digest は
  // adopt の有無に関係なく常にこの plan から取る。
  const [plan, setPlan] = useState<ReconciliationPlan | null>(null)
  const [adopted, setAdopted] = useState<Readonly<Record<string, true>>>({})
  // adopt を全件確認した後に adoptHostnames=requiredAdopt で取り直した plan。
  // adopt 付き apply はこの plan を表示した上でこの digest で送る
  // (operator が見た plan = apply される plan)。
  const [adoptPlan, setAdoptPlan] = useState<ReconciliationPlan | null>(null)
  const [cleanupConfirm, setCleanupConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [lastOp, setLastOp] = useState<Operation | null>(null)

  const requiredAdopt = plan === null ? [] : adoptRequiredHostnames(plan)
  const allAdopted = requiredAdopt.every((h) => adopted[h] === true)
  // adopt 不要なら診断した plan をそのまま、必要なら adopt 付きで取り直した plan を
  // apply する。取り直すまでは null (= 適用不可)。
  const applyPlan = requiredAdopt.length === 0 ? plan : adoptPlan
  const shownPlan = applyPlan ?? plan
  const cleanupTargets = plan === null ? [] : cleanupTargetEntries(plan)
  const cleanupBlocked = plan === null ? [] : blockedHostnames(plan)

  const resetPlans = () => {
    setPlan(null)
    setAdoptPlan(null)
    setAdopted({})
    setCleanupConfirm(false)
  }

  const runPlan = async () => {
    setError(null)
    setNotice(null)
    setBusy(true)
    setLastOp(null)
    try {
      // plan 再取得時は前回の adopt チェック状態を保持しない (別の plan/revision の
      // ホスト名が残ると誤 apply の危険がある)。
      const p = await api.planReconciliation(contestId, { adoptHostnames: [] })
      resetPlans()
      setPlan(p)
    } catch (err) {
      setError(messageForError(err, "診断に失敗しました"))
    } finally {
      setBusy(false)
    }
  }

  const toggleAdopt = (hostname: string, checked: boolean) => {
    setAdopted((prev) => {
      const next = { ...prev }
      if (checked) next[hostname] = true
      else delete next[hostname]
      return next
    })
    // adopt 集合が変わったら、取り直した plan は operator が確認した集合と
    // 一致しなくなるので破棄する (adopt=[] の plan 表示に戻る)。
    setAdoptPlan(null)
  }

  const runAdoptPlan = async () => {
    if (plan === null || requiredAdopt.length === 0 || !allAdopted) return
    setError(null)
    setBusy(true)
    try {
      setAdoptPlan(await api.planReconciliation(contestId, { adoptHostnames: requiredAdopt }))
    } catch (err) {
      setError(messageForError(err, "adopt を反映した plan の取得に失敗しました"))
    } finally {
      setBusy(false)
    }
  }

  const runApply = async () => {
    if (applyPlan === null) return
    setError(null)
    setBusy(true)
    try {
      const op = await api.applyReconciliation(contestId, {
        planDigest: applyPlan.planDigest,
        // digest を計算したときの adoptHostnames を同じ plan から送る。
        adoptHostnames: applyPlan.adoptHostnames
      })
      setLastOp(op)
      // 適用済み plan は無効化する (stale 前提)。
      resetPlans()
    } catch (err) {
      setError(messageForError(err, "適用に失敗しました"))
    } finally {
      setBusy(false)
    }
  }

  const runCleanup = async () => {
    if (plan === null || !cleanupConfirm || cleanupBlocked.length > 0) return
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      // server は adoptHostnames=[] で plan を取り直すので、adopt=[] の plan の digest を送る。
      const op = await api.requestContestCleanup(contestId, { planDigest: plan.planDigest })
      setLastOp(op)
      resetPlans()
    } catch (err) {
      if (err instanceof ApiError && err.tag === "NothingToReconcile") {
        // 撤収するものが無い = 目的の状態に到達済み。失敗ではない。
        setNotice("cleanup 対象はありません (既に clean)")
        resetPlans()
      } else {
        setError(messageForError(err, "cleanup に失敗しました"))
      }
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
      {shownPlan !== null && (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>hostname</th>
                  <th>classification</th>
                  <th>action</th>
                  <th>Proxmox VMID</th>
                  <th>CF DNS</th>
                  <th>CF ingress</th>
                  <th>CF app</th>
                  <th>reason</th>
                </tr>
              </thead>
              <tbody>
                {shownPlan.entries.map((e: ReconciliationEntry) => (
                  <tr key={e.hostname}>
                    <td className="mono">{e.hostname}</td>
                    <td>{e.classification}</td>
                    <td>{e.action}</td>
                    <td className="num mono">{e.proxmoxVmid ?? "-"}</td>
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
                個別に確認し、全件確認したら adopt を反映した plan を取得して、
                action が adopt_cleanup に変わったことを確かめてから適用してください。
              </p>
              {requiredAdopt.map((h) => (
                <label key={h} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={adopted[h] === true}
                    disabled={busy}
                    onChange={(e) => toggleAdopt(h, e.target.checked)}
                  />
                  <span className="mono">{h}</span>
                </label>
              ))}
              <div className="section-actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busy || !allAdopted || adoptPlan !== null}
                  onClick={runAdoptPlan}
                >
                  adopt を反映した plan を取得
                </button>
              </div>
            </div>
          )}
          <div className="section-actions">
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy || applyPlan === null}
              onClick={runApply}
            >
              適用
            </button>
            <p className="disabled-reason mono">
              plan digest: {shownPlan.planDigest.slice(0, 12)}…
            </p>
          </div>
        </>
      )}
      {actions.cleanup && plan !== null && (
        <div className="dangerous-actions">
          <h3>Cleanup</h3>
          <p className="hint">
            外部リソースを撤収し Instance を deleted に遷移します。server は adopt なしで
            plan を取り直すので、対象は「診断」で取得した plan のものです。
          </p>
          {cleanupTargets.length === 0 && cleanupBlocked.length === 0 ? (
            <p className="notice-ok">cleanup 対象はありません (既に clean)</p>
          ) : (
            <>
              <ul>
                {cleanupTargets.map((e) => (
                  <li key={e.hostname} data-testid="cleanup-target">
                    <span className="mono">{e.hostname}</span> — VMID{" "}
                    <span className="mono">{e.proxmoxVmid ?? "なし"}</span>
                  </li>
                ))}
              </ul>
              {cleanupBlocked.length > 0 && (
                <p className="disabled-reason">
                  blocked の entry があるため cleanup できません。cleanup は adopt せずに plan を
                  取り直すので、unmanaged_orphan は先に adopt して適用し、診断し直してください:{" "}
                  <span className="mono">{cleanupBlocked.join(", ")}</span>
                </p>
              )}
              <ConfirmCheckbox
                checked={cleanupConfirm}
                onChange={setCleanupConfirm}
                description={`上記 ${cleanupTargets.length} 件の hostname について、表示した VMID の Proxmox VM、Cloudflare DNS / tunnel ingress / Access application、ResourceBinding を撤収し、Instance を deleted に遷移します。元に戻せません。`}
              />
              <div className="section-actions">
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={busy || !cleanupConfirm || cleanupBlocked.length > 0 || cleanupTargets.length === 0}
                  aria-busy={busy}
                  onClick={runCleanup}
                >
                  cleanup 実行
                </button>
                <p className="disabled-reason mono">plan digest: {plan.planDigest.slice(0, 12)}…</p>
              </div>
            </>
          )}
        </div>
      )}
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice !== null && <p className="notice-ok">{notice}</p>}
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
      setArtifacts(await api.listAdminContestArtifacts(contestId))
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
                    {/* 全 kind を AdminOnly download に通す。公開 download は
                        snapshot を 404 にするうえ、scoreboard 系は
                        `public, max-age=60` を返す。artifact 行は
                        unique(contest_id, kind) の in-place upsert なので
                        archive 再生成後も id が変わらず、公開経路だと表示中の
                        sha256 と食い違う stale bytes を掴みうる。admin download は
                        `no-store` なので常に検証対象の実体を取得できる。 */}
                    <a href={`/api/admin/artifacts/${a.id}/download`}>download</a>
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
