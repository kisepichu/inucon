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
export const requestPath = (req: HttpClientRequest.HttpClientRequest): string =>
  HttpClientRequest.toUrl(req).pipe(
    Option.map((u) => u.pathname),
    Option.getOrElse(() => req.url)
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
