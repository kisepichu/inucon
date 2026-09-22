import { useCallback, useEffect, useState } from "react"
import type { Contest, CreateContestDraftRequest } from "shared/schemas"
import { ApiError, api } from "../api.ts"

// Task 5: 5 セクション(Metadata / Schedule / Teams / Capacity / Review)を
// 1 ページで表示する draft wizard。
//
// - Persist only on final submission: 中間値はコンポーネント内 state に留める。
//   「作成」を押した瞬間だけ POST /api/admin/contests を呼ぶ。
// - 「確認へ」で Review パネルを開く。それまでの入力が確定値になる。
// - defaults:
//   - edition = max(edition WHERE status != 'canceled') + 1
//   - quota = 3
//   - schedule すべて null(明示入力時のみ埋まる)
//   - teamCount = 1 (第2回想定「1 チーム・quota 3」)
//   - schedule で end を入れて accessClose を触っていなければ、accessClose を
//     end と同じ値に自動で埋める
//
// 「合計 VM: N台」は quota * teamCount。teamCount は Teams セクションの入力値
// を反映する(未入力なら 1)。

// datetime-local(RFC 3339 の秒省略形)⇔ epoch ms 相互変換。null は "" に。
const toDatetimeLocal = (millis: number | null): string => {
  if (millis === null) return ""
  const d = new Date(millis)
  const pad = (n: number) => n.toString().padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const fromDatetimeLocal = (value: string): number | null => {
  if (value === "") return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

interface FormState {
  edition: string
  name: string
  problemKey: string
  problemRevision: string
  templateVmid: string
  instanceQuota: string
  scheduledStartAt: string
  scheduledEndAt: string
  accessClosesAt: string
  cleanupAt: string
  teamCount: string
}

const defaultForm: FormState = {
  edition: "1",
  name: "INUCON",
  problemKey: "private-isu",
  problemRevision: "",
  templateVmid: "9100",
  instanceQuota: "3",
  scheduledStartAt: "",
  scheduledEndAt: "",
  accessClosesAt: "",
  cleanupAt: "",
  teamCount: "1"
}

const parsePositiveInt = (value: string, fallback: number): number => {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

interface ContestSetupProps {
  readonly onCreated: (contest: Contest) => void
}

export function ContestSetup({ onCreated }: ContestSetupProps) {
  const [form, setForm] = useState<FormState>(defaultForm)
  const [accessCloseTouched, setAccessCloseTouched] = useState(false)
  const [editionTouched, setEditionTouched] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 既存 Contest 一覧から次の edition 既定値を計算する。canceled は無視。
  // ユーザーが既に edition を触っていたら上書きしない(race 対策)。
  useEffect(() => {
    let canceled = false
    const load = async () => {
      try {
        const contests = await api.listAdminContests(true)
        if (canceled) return
        const liveMax = contests
          .filter((c) => c.status !== "canceled")
          .reduce((acc, c) => Math.max(acc, c.edition), 0)
        setForm((prev) => (editionTouched ? prev : { ...prev, edition: `${liveMax + 1}` }))
      } catch {
        // 一覧取得は必須ではない(0 件相当としてフォームの既定 edition=1 のまま)。
      }
    }
    load()
    return () => {
      canceled = true
    }
  }, [editionTouched])

  const update = useCallback((key: keyof FormState, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }))
    if (key === "accessClosesAt") setAccessCloseTouched(true)
    if (key === "edition") setEditionTouched(true)
  }, [])

  const buildPayload = useCallback(
    (state: FormState): CreateContestDraftRequest => {
      const end = fromDatetimeLocal(state.scheduledEndAt)
      // accessClose を明示的に触っていなければ、end を自動流用する。
      const accessClose = accessCloseTouched ? fromDatetimeLocal(state.accessClosesAt) : end
      return {
        edition: parsePositiveInt(state.edition, 1),
        name: state.name,
        problemKey: state.problemKey,
        problemRevision: state.problemRevision,
        templateVmid: parsePositiveInt(state.templateVmid, 9100),
        instanceQuota: parsePositiveInt(state.instanceQuota, 3),
        scheduledStartAt: fromDatetimeLocal(state.scheduledStartAt),
        scheduledEndAt: end,
        accessClosesAt: accessClose,
        cleanupAt: fromDatetimeLocal(state.cleanupAt)
      }
    },
    [accessCloseTouched]
  )

  const enterReview = useCallback(() => {
    // end を触って accessClose を触っていなければ、fromDatetimeLocal(end) を
    // datetime-local 文字列に戻して visible な入力にも反映する(UX 上、Review
    // に入る時点で「実際に送る値」を全部見せる)。
    if (!accessCloseTouched && form.scheduledEndAt !== "") {
      setForm((prev) => ({ ...prev, accessClosesAt: prev.scheduledEndAt }))
    }
    setError(null)
    setReviewing(true)
  }, [accessCloseTouched, form.scheduledEndAt])

  const submit = useCallback(async () => {
    setSubmitting(true)
    setError(null)
    try {
      const created = await api.createContestDraft(buildPayload(form))
      onCreated(created)
    } catch (err) {
      if (err instanceof ApiError) {
        setError(`作成に失敗しました (${err.tag}, HTTP ${err.status})`)
      } else {
        setError("作成に失敗しました")
      }
    } finally {
      setSubmitting(false)
    }
  }, [buildPayload, form, onCreated])

  const teamCount = parsePositiveInt(form.teamCount, 1)
  const quota = parsePositiveInt(form.instanceQuota, 3)
  const totalVms = teamCount * quota

  return (
    <div className="contest-setup">
      <h1>新しい大会 (draft) を作る</h1>

      <section aria-labelledby="section-metadata">
        <h2 id="section-metadata">1. メタデータ</h2>
        <label>
          開催回
          <input
            type="number"
            value={form.edition}
            onChange={(e) => update("edition", e.target.value)}
            min={1}
          />
        </label>
        <label>
          大会名
          <input value={form.name} onChange={(e) => update("name", e.target.value)} />
        </label>
        <label>
          問題キー
          <input value={form.problemKey} onChange={(e) => update("problemKey", e.target.value)} />
        </label>
        <label>
          問題リビジョン
          <input
            value={form.problemRevision}
            onChange={(e) => update("problemRevision", e.target.value)}
          />
        </label>
        <label>
          テンプレート VMID
          <input
            type="number"
            value={form.templateVmid}
            onChange={(e) => update("templateVmid", e.target.value)}
            min={1}
          />
        </label>
      </section>

      <section aria-labelledby="section-schedule">
        <h2 id="section-schedule">2. スケジュール</h2>
        <label>
          開始
          <input
            type="datetime-local"
            value={form.scheduledStartAt}
            onChange={(e) => update("scheduledStartAt", e.target.value)}
          />
        </label>
        <label>
          終了
          <input
            type="datetime-local"
            value={form.scheduledEndAt}
            onChange={(e) => update("scheduledEndAt", e.target.value)}
          />
        </label>
        <label>
          Access 閉鎖
          <input
            type="datetime-local"
            value={form.accessClosesAt}
            onChange={(e) => update("accessClosesAt", e.target.value)}
          />
        </label>
        <label>
          クリーンアップ
          <input
            type="datetime-local"
            value={form.cleanupAt}
            onChange={(e) => update("cleanupAt", e.target.value)}
          />
        </label>
      </section>

      <section aria-labelledby="section-teams">
        <h2 id="section-teams">3. チームとメンバー</h2>
        <p className="hint">
          チーム編成・招待は Contest 作成後に「Admin」ページから行います。
          ここでは合計 VM 数計算に使うチーム数だけ入力します。
        </p>
        <label>
          想定チーム数
          <input
            type="number"
            value={form.teamCount}
            onChange={(e) => update("teamCount", e.target.value)}
            min={1}
          />
        </label>
      </section>

      <section aria-labelledby="section-capacity">
        <h2 id="section-capacity">4. キャパシティ</h2>
        <label>
          チームあたりインスタンス上限 (quota)
          <input
            type="number"
            value={form.instanceQuota}
            onChange={(e) => update("instanceQuota", e.target.value)}
            min={1}
          />
        </label>
      </section>

      <div className="contest-setup-actions">
        {!reviewing && (
          <button type="button" onClick={enterReview}>
            確認へ
          </button>
        )}
      </div>

      {reviewing && (
        <section aria-labelledby="section-review" className="contest-setup-review">
          <h2 id="section-review">5. 確認</h2>
          <dl>
            <dt>開催回</dt>
            <dd>{form.edition}</dd>
            <dt>大会名</dt>
            <dd>{form.name}</dd>
            <dt>問題</dt>
            <dd>
              {form.problemKey} @ {form.problemRevision || "(未指定)"}
            </dd>
            <dt>スケジュール</dt>
            <dd>
              {form.scheduledStartAt || "未設定"} → {form.scheduledEndAt || "未設定"}
              <br />
              Access 閉鎖: {form.accessClosesAt || "未設定"}
              <br />
              クリーンアップ: {form.cleanupAt || "未設定"}
            </dd>
            <dt>キャパシティ</dt>
            <dd>
              quota {quota} / 想定 {teamCount} チーム
            </dd>
            <dt>合計 VM</dt>
            <dd>合計 VM: {totalVms}台</dd>
          </dl>
          <div className="contest-setup-actions">
            <button type="button" onClick={() => setReviewing(false)} disabled={submitting}>
              戻る
            </button>
            <button type="button" onClick={submit} disabled={submitting}>
              作成
            </button>
          </div>
          {error !== null && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </section>
      )}
    </div>
  )
}

// toDatetimeLocal は将来 draft の再編集画面で使うためのエクスポート。
export { toDatetimeLocal }
