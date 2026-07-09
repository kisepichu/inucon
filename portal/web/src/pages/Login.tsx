import { loginUrl } from "../api.ts"

// 未ログイン時に表示するページ。GitHub OAuth はフルページ遷移で開始する
// (SPA からは location.href、スペック §7)。
export function Login() {
  return (
    <div className="login-page">
      <h1>INUCON</h1>
      <p>参加するには GitHub でログインしてください。</p>
      <button
        type="button"
        onClick={() => {
          window.location.href = loginUrl
        }}
      >
        GitHub でログイン
      </button>
    </div>
  )
}
