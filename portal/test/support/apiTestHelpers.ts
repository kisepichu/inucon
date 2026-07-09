import { HttpApiClient, HttpClient, HttpClientRequest } from "@effect/platform"
import { Effect } from "effect"
import { api } from "shared"
import { login } from "./login.js"
import { makeAppTestLayer } from "./testApi.js"

// 本物の api(shared)を、AdminOnly/Authentication ともに本物の Live を通して
// 起動する(test/http/auth.test.ts の TestLayer と同じ形)。admin-login が
// ADMIN_GITHUB_LOGINS 相当。
export const TestLayer = makeAppTestLayer({ adminGithubLogins: ["admin-login"] })

export const asAdmin = () => login({ githubLogin: "admin-login", githubId: 900, isAdmin: true })

// cookie ヘッダは HttpApiClient の request 引数に無いため transformClient で
// 注入する(test/http/auth.test.ts の makeApiClient と同じ形)。
export const makeApiClient = (cookieHeader: string) =>
  HttpApiClient.make(api, {
    transformClient: (client) => HttpClient.mapRequest(client, HttpClientRequest.setHeader("cookie", cookieHeader))
  })
