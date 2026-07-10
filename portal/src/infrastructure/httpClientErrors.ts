import { HttpClientRequest } from "@effect/platform"
import { Option } from "effect"

// Proxmox/Cloudflare クライアント共通: HTTP 呼び出し失敗の cause を安全な文字列にする。
//
// @effect/platform の RequestError/ResponseError は失敗の原因となった
// HttpClientRequest 自体(Authorization ヘッダ = トークンを含む)をプロパティとして
// 保持している。これをそのまま TaggedError(ProxmoxError/CloudflareError)の cause に
// 格納すると、cause をログに出力・シリアライズした際にトークンが漏れる。
// そのため、cause には「メソッド + URL のパス部分 + エラーの種類/メッセージ」のみを
// 残した文字列を格納する(ヘッダ・クエリ文字列・トークンは含めない)。

// クエリパラメータ(urlParams)を含まない、URL のパス部分のみを取り出す。
// toUrl が None のフォールバックでも、req.url に混じりうるクエリ文字列を
// 落とす(URL にトークンが入っていた場合の漏洩を防ぐ)。絶対 URL ならパス部を、
// 相対でもクエリ以降を捨てる。
const stripQuery = (raw: string): string => {
  try {
    return new URL(raw).pathname
  } catch {
    const q = raw.indexOf("?")
    return q === -1 ? raw : raw.slice(0, q)
  }
}

export const requestPath = (req: HttpClientRequest.HttpClientRequest): string =>
  HttpClientRequest.toUrl(req).pipe(
    Option.map((u) => u.pathname),
    Option.getOrElse(() => stripQuery(req.url))
  )

// 任意の失敗値(RequestError/ResponseError/ParseError 等)を安全な文字列に変換する。
export const describeHttpFailure = (req: HttpClientRequest.HttpClientRequest, cause: unknown): string => {
  const tag =
    typeof cause === "object" && cause !== null && "_tag" in cause
      ? String((cause as { _tag: unknown })._tag)
      : cause instanceof Error
      ? cause.constructor.name
      : typeof cause
  const message = cause instanceof Error ? cause.message : String(cause)
  return `${req.method} ${requestPath(req)} — ${tag}: ${message}`
}
