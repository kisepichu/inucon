import { HttpClient, HttpClientRequest } from "@effect/platform"
import { Effect, Layer } from "effect"
import { GithubKeysError, GithubKeysPort } from "../../application/ports.js"

// authorized_keys 形式(<keytype> <base64> [comment])の許可リスト検証。
// 計画の Global Constraints(2026-07-10-phase3-selfservice.md)で確定した正規表現をそのまま使う。
// keytype と keydata の間は 1 個以上の空白必須、改行・制御文字を含む鍵は弾く。
export const authorizedKeyPattern =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) +[A-Za-z0-9+/]+=* *(\S.*)?$/

export const GithubKeysLive: Layer.Layer<GithubKeysPort, never, HttpClient.HttpClient> = Layer.effect(
  GithubKeysPort,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient

    return {
      fetchKeys: (login) =>
        Effect.gen(function* () {
          const request = HttpClientRequest.get(`https://github.com/${login}.keys`)
          const response = yield* client.execute(request).pipe(
            Effect.mapError((cause) => new GithubKeysError({ cause }))
          )
          if (response.status !== 200) {
            return yield* Effect.fail(
              new GithubKeysError({ cause: `unexpected status ${response.status} for ${login}` })
            )
          }
          const body = yield* response.text.pipe(
            Effect.mapError((cause) => new GithubKeysError({ cause }))
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
