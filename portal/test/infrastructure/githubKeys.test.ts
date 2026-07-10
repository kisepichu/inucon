import { HttpClient, HttpClientResponse } from "@effect/platform"
import type { HttpClientRequest } from "@effect/platform"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { describe, expect } from "vitest"
import { GithubKeysError, GithubKeysPort } from "../../src/application/ports.js"
import { GithubKeysLive } from "../../src/infrastructure/github/keys.js"

// GithubKeysLive を、github.com/<login>.keys を模した fake HttpClient の上で
// 検証する。実 HTTP は発生しない(githubOAuth.test.ts と同じパターン)。

const textResponse = (request: HttpClientRequest.HttpClientRequest, body: string, status = 200) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(body, { status, headers: { "content-type": "text/plain" } })
  )

const makeFakeGithub = (byLogin: Record<string, { body: string; status?: number }>) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  const client = HttpClient.make((request) => {
    requests.push(request)
    const login = request.url.replace("https://github.com/", "").replace(".keys", "")
    const entry = byLogin[login]
    if (entry === undefined) {
      return Effect.succeed(textResponse(request, "Not Found", 404))
    }
    return Effect.succeed(textResponse(request, entry.body, entry.status ?? 200))
  })
  return { requests, layer: Layer.succeed(HttpClient.HttpClient, client) }
}

const portLayer = (fake: { layer: Layer.Layer<HttpClient.HttpClient> }) =>
  GithubKeysLive.pipe(Layer.provide(fake.layer))

const ed25519Key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabcdef0123456789 octocat@example"
const rsaKey = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC1abc123== octocat@example"

describe("fetchKeys", () => {
  it.effect("正常系: 複数行の鍵をすべて返す", () =>
    Effect.gen(function* () {
      const fake = makeFakeGithub({ octocat: { body: `${ed25519Key}\n${rsaKey}\n` } })
      const keys = yield* GithubKeysPort.pipe(
        Effect.flatMap((port) => port.fetchKeys("octocat")),
        Effect.provide(portLayer(fake))
      )
      expect(keys).toStrictEqual([ed25519Key, rsaKey])

      const [req] = fake.requests
      expect(req.method).toBe("GET")
      expect(req.url).toBe("https://github.com/octocat.keys")
    })
  )

  it.effect("空(鍵未登録)は GithubKeysError", () =>
    Effect.gen(function* () {
      const fake = makeFakeGithub({ "no-keys": { body: "" } })
      const error = yield* GithubKeysPort.pipe(
        Effect.flatMap((port) => port.fetchKeys("no-keys")),
        Effect.provide(portLayer(fake)),
        Effect.flip
      )
      expect(error).toBeInstanceOf(GithubKeysError)
    })
  )

  it.effect("空白のみのレスポンスも GithubKeysError", () =>
    Effect.gen(function* () {
      const fake = makeFakeGithub({ blank: { body: "\n\n  \n" } })
      const error = yield* GithubKeysPort.pipe(
        Effect.flatMap((port) => port.fetchKeys("blank")),
        Effect.provide(portLayer(fake)),
        Effect.flip
      )
      expect(error).toBeInstanceOf(GithubKeysError)
    })
  )

  it.effect("不正な形式の行は除去し、有効な行だけ返す", () =>
    Effect.gen(function* () {
      const fake = makeFakeGithub({
        mixed: { body: `${ed25519Key}\nnot-a-valid-key-line\nssh-ed25519\n${rsaKey}\n` }
      })
      const keys = yield* GithubKeysPort.pipe(
        Effect.flatMap((port) => port.fetchKeys("mixed")),
        Effect.provide(portLayer(fake))
      )
      expect(keys).toStrictEqual([ed25519Key, rsaKey])
    })
  )

  it.effect("全行が不正な形式なら GithubKeysError(有効な鍵が 0 件)", () =>
    Effect.gen(function* () {
      const fake = makeFakeGithub({ garbage: { body: "not-a-key\nalso not a key\n" } })
      const error = yield* GithubKeysPort.pipe(
        Effect.flatMap((port) => port.fetchKeys("garbage")),
        Effect.provide(portLayer(fake)),
        Effect.flip
      )
      expect(error).toBeInstanceOf(GithubKeysError)
    })
  )

  it.effect("404(ユーザー不在)は GithubKeysError", () =>
    Effect.gen(function* () {
      const fake = makeFakeGithub({})
      const error = yield* GithubKeysPort.pipe(
        Effect.flatMap((port) => port.fetchKeys("nonexistent")),
        Effect.provide(portLayer(fake)),
        Effect.flip
      )
      expect(error).toBeInstanceOf(GithubKeysError)
    })
  )
})
