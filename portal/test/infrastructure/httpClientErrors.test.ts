import { HttpClientError, HttpClientRequest } from "@effect/platform"
import { describe, expect, it } from "vitest"
import { describeHttpFailure, requestPath } from "../../src/infrastructure/httpClientErrors.js"

// describeHttpFailure がトークン(Authorization ヘッダ)やクエリ文字列を漏らさない
// ことの回帰テスト。実装が変わっても cause 文字列に秘密が入らないことを固定する。
describe("describeHttpFailure", () => {
  const secret = "PVEAPIToken=portal@pve!inucon=super-secret-token-value"

  const req = HttpClientRequest.get("https://192.0.2.10:8006/api2/json/nodes/eevee/status").pipe(
    HttpClientRequest.setHeader("Authorization", secret),
    HttpClientRequest.setUrlParam("apitoken", secret)
  )

  it("メソッドとパスのみを含み、トークン・ヘッダ・クエリを含まない", () => {
    const cause = new HttpClientError.RequestError({ request: req, reason: "Transport", cause: "boom" })
    const desc = describeHttpFailure(req, cause)

    expect(desc).toContain("GET")
    expect(desc).toContain("/api2/json/nodes/eevee/status")
    // 秘密は一切含まれない
    expect(desc).not.toContain("super-secret-token-value")
    expect(desc).not.toContain("PVEAPIToken")
    expect(desc).not.toContain("apitoken")
  })

  it("requestPath は urlParams を落としてパスのみ返す", () => {
    expect(requestPath(req)).toBe("/api2/json/nodes/eevee/status")
  })
})
