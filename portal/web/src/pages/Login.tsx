import { loginUrl } from "../api.ts"

// 未ログイン時に表示するページ。GitHub OAuth はフルページ遷移で開始する
// (SPA からは location.href、スペック §7)。
export function Login() {
  return (
    <div className="login-page">
      <h1>INUCON</h1>
      <p>GitHub でログインすると、参加チームや管理画面の閲覧ができます(参加チームへの割り当ては主催者が行います)。</p>
      <button
        type="button"
        className="btn btn-github"
        onClick={() => {
          window.location.href = loginUrl
        }}
      >
        GitHub でログイン
      </button>
    </div>
  )
}
