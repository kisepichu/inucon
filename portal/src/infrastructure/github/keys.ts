import { HttpClient, HttpClientRequest } from "@effect/platform"
import { Effect, Layer } from "effect"
import { GithubKeysError, GithubKeysPort } from "../../application/ports.js"
import { describeHttpFailure, requestPath } from "../httpClientErrors.js"

// authorized_keys 形式(<keytype> <base64> [comment])の許可リスト検証。
// 計画の Global Constraints(2026-07-10-phase3-selfservice.md)で確定した正規表現をそのまま使う。
// keytype と keydata の間は 1 個以上の空白必須、改行・制御文字を含む鍵は弾く。
// keytype(許可リスト)+ 空白 + keydata(base64、実鍵は数十文字以上なので
// 20 文字以上を要求 + 最大 3 文字の = パディング)+ 任意のコメント
// (空白区切り必須、制御文字は不可)。
export const authorizedKeyPattern =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) +[A-Za-z0-9+/]{20,}={0,3}( +[^\x00-\x1F\x7F]*)?$/

export const GithubKeysLive: Layer.Layer<GithubKeysPort, never, HttpClient.HttpClient> = Layer.effect(
  GithubKeysPort,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient

    return {
      fetchKeys: (login) =>
        Effect.gen(function* () {
          // login に / や ? が混じっても意図しないパス解釈にならないようエスケープする。
          const request = HttpClientRequest.get(`https://github.com/${encodeURIComponent(login)}.keys`)
          const response = yield* client.execute(request).pipe(
            // Proxmox/Cloudflare と同様、生の RequestError(将来ヘッダ等を含みうる)
            // を cause に入れず、メソッド+パスのみの安全な文字列にする。
            Effect.mapError((cause) => new GithubKeysError({ cause: describeHttpFailure(request, cause) }))
          )
          if (response.status !== 200) {
            return yield* Effect.fail(
              // HTTP 失敗の cause は Proxmox/Cloudflare と同じく method + パス + status に
              // 揃える(ユーザー入力 login を生でログに残さない)。
              new GithubKeysError({ cause: `${request.method} ${requestPath(request)} → ${response.status}` })
            )
          }
          const body = yield* response.text.pipe(
            Effect.mapError((cause) => new GithubKeysError({ cause: describeHttpFailure(request, cause) }))
          )
          if (body.trim() === "") {
            return yield* Effect.fail(new GithubKeysError({ cause: `no keys registered for ${login}` }))
          }
          const validKeys = body
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== "")
            .filter((line) => authorizedKeyPattern.test(line))
          if (validKeys.length === 0) {
            return yield* Effect.fail(
              new GithubKeysError({ cause: `no valid authorized_keys lines for ${login}` })
            )
          }
          return validKeys
        }).pipe(Effect.scoped)
    }
  })
)
