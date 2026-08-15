import { useCallback, useEffect, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import type { Contest } from "shared/schemas"
import { ApiError, api } from "../api.ts"

// Task 5: 大会一覧ページ(admin 用)。開催回・状態を一覧し、「新規作成」で
// ContestSetup 画面へ遷移する。canceled は includeCanceled で切り替えて監査目的で
// 表示できる。
//
// Contest スキーマ上の schedule フィールドは Schema.OptionFromNullOr で
// Type が Option<number> になっているが、web fetch は JSON をそのまま受け取る
// ため runtime は null|number。Option を経由せずに扱いたいのでキャストする。
const nullableMillis = (v: unknown): number | null =>
  typeof v === "number" ? v : null
const formatDate = (v: unknown) => {
  const millis = nullableMillis(v)
  return millis === null ? "-" : new Date(millis).toLocaleString()
}


export function Contests() {
  const [contests, setContests] = useState<Array<Contest>>([])
  const [includeCanceled, setIncludeCanceled] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  const load = useCallback(async () => {
    setError(null)
    try {
      const list = await api.listAdminContests(includeCanceled)
      setContests(list)
    } catch (err) {
      if (err instanceof ApiError) {
        setError(`一覧取得に失敗しました (${err.tag}, HTTP ${err.status})`)
      } else {
        setError("一覧取得に失敗しました")
      }
    }
  }, [includeCanceled])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="contests-page">
      <div className="page-header">
        <h1>大会一覧</h1>
        <button type="button" onClick={() => navigate("/admin/contests/new")}>
          新しい大会を作る
        </button>
      </div>

      <label>
        <input
          type="checkbox"
          checked={includeCanceled}
          onChange={(e) => setIncludeCanceled(e.target.checked)}
        />
        canceled も表示する (監査用)
      </label>

      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <table>
        <thead>
          <tr>
            <th>開催回</th>
            <th>大会名</th>
            <th>状態</th>
            <th>問題</th>
            <th>quota</th>
            <th>開始</th>
            <th>終了</th>
            <th>アーカイブ</th>
          </tr>
        </thead>
        <tbody>
          {contests.map((c) => (
            <tr key={c.id}>
              <td>#{c.edition}</td>
              <td>{c.name}</td>
              <td>{c.status}</td>
              <td>{c.problemKey} @ {c.problemRevision}</td>
              <td>{c.instanceQuota}</td>
              <td>{formatDate(c.scheduledStartAt)}</td>
              <td>{formatDate(c.scheduledEndAt)}</td>
              <td>
                <Link to={`/?contest=${c.id}`}>スコアボード</Link>
              </td>
            </tr>
          ))}
          {contests.length === 0 && (
            <tr>
              <td colSpan={8}>まだ大会がありません。</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
