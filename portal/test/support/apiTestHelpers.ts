import { HttpApiClient, HttpClient, HttpClientRequest } from "@effect/platform"
import { Effect } from "effect"
import { api } from "shared"
import { ContestRepo } from "../../src/application/ports.js"
import { DEFAULT_TEST_CONTEST_ID, makeContest } from "./factories.js"
import { login } from "./login.js"
import { makeAppTestLayer, RUNNER_TOKEN_TEST } from "./testApi.js"

// 本物の api(shared)を、AdminOnly/Authentication ともに本物の Live を通して
// 起動する(test/http/auth.test.ts の TestLayer と同じ形)。admin-login が
// ADMIN_GITHUB_LOGINS 相当。
export const TestLayer = makeAppTestLayer({ adminGithubLogins: ["admin-login"] })

export const asAdmin = () => login({ githubLogin: "admin-login", githubId: 900, isAdmin: true })

// Task 3: 全 http テストは operational な contest を前提とするようになった。
// 既存の (contest 依存でない) テスト用に、preparing な contest を 1 件 seed する
// ヘルパー。DEFAULT_TEST_CONTEST_ID を使うので他のテストヘルパーとも整合する。
export const seedOperationalContest = (status: "preparing" | "running" = "preparing") =>
  Effect.gen(function* () {
    const contests = yield* ContestRepo
    yield* contests.create(makeContest({ id: DEFAULT_TEST_CONTEST_ID, status }))
  })

// cookie ヘッダは HttpApiClient の request 引数に無いため transformClient で
// 注入する(test/http/auth.test.ts の makeApiClient と同じ形)。
export const makeApiClient = (cookieHeader: string) =>
  HttpApiClient.make(api, {
    transformClient: (client) => HttpClient.mapRequest(client, HttpClientRequest.setHeader("cookie", cookieHeader))
  })

// runner(bearer token)グループ用の HttpApiClient。cookie と同様、HttpApiClient
// の呼び出し引数に認証情報を渡す口が無いため transformClient で Authorization
// ヘッダを注入する。
export const makeRunnerApiClient = () =>
  HttpApiClient.make(api, {
    transformClient: (client) =>
      HttpClient.mapRequest(client, HttpClientRequest.setHeader("authorization", `Bearer ${RUNNER_TOKEN_TEST}`))
  })
