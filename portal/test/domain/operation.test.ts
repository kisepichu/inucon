import { Data, Either, Option } from "effect"
import { describe, expect, it } from "vitest"
import {
  cancelOperation,
  completeOperation,
  isOperationUnfinished,
  markOperationBlocked,
  markOperationFailed,
  markOperationRunning,
  sanitizeOperationError
} from "../../src/domain/operation.js"
import { InvalidOperationTransition } from "../../src/domain/errors.js"
import { makeOperation } from "../support/factories.js"

// Task 6: Operation ステートマシン + sanitizeOperationError 単体テスト。
//
// 単一 unfinished Operation は「isOperationUnfinished が false になる状態が
// 全体で最大 1」を DB 側の partial unique と一致させる意味付け。ドメイン層は
// 「どの状態が unfinished か」だけを表現し、実際の排他は Repository が担う。

describe("Operation state machine", () => {
  it("queued -> running stamps startedAt", () => {
    const op = makeOperation({ status: "queued" })
    const next = markOperationRunning(op, 100)
    expect(Either.isRight(next)).toBe(true)
    if (Either.isRight(next)) {
      expect(next.right.status).toBe("running")
      expect(next.right.startedAt).toStrictEqual(Option.some(100))
    }
  })

  it("running -> succeeded stamps finishedAt and releases the lock", () => {
    const op = makeOperation({ status: "running", startedAt: Option.some(50) })
    const next = completeOperation(op, 200)
    expect(Either.isRight(next)).toBe(true)
    if (Either.isRight(next)) {
      expect(next.right.status).toBe("succeeded")
      expect(next.right.finishedAt).toStrictEqual(Option.some(200))
      // succeeded は unfinished ではない(partial unique から抜ける)。
      expect(isOperationUnfinished(next.right)).toBe(false)
    }
  })

  it("running -> failed keeps the lock (still unfinished)", () => {
    const op = makeOperation({ status: "running" })
    const err = sanitizeOperationError(new Error("boom"))
    const next = markOperationFailed(op, err, 200)
    expect(Either.isRight(next)).toBe(true)
    if (Either.isRight(next)) {
      expect(next.right.status).toBe("failed")
      // failed は依然 unfinished(operator の retry/cancel 待ち)。
      expect(isOperationUnfinished(next.right)).toBe(true)
    }
  })

  it("running -> blocked keeps the lock (still unfinished)", () => {
    const op = makeOperation({ status: "running" })
    const err = sanitizeOperationError({ _tag: "InvalidContestTransition", from: "draft", to: "running" })
    const next = markOperationBlocked(op, err, 200)
    expect(Either.isRight(next)).toBe(true)
    if (Either.isRight(next)) {
      expect(next.right.status).toBe("blocked")
      expect(isOperationUnfinished(next.right)).toBe(true)
    }
  })

  it("cancelOperation accepts queued/failed/blocked but rejects running/succeeded/canceled", () => {
    for (const from of ["queued", "failed", "blocked"] as const) {
      const next = cancelOperation(makeOperation({ status: from }), 300)
      expect(Either.isRight(next)).toBe(true)
      if (Either.isRight(next)) {
        expect(next.right.status).toBe("canceled")
        expect(isOperationUnfinished(next.right)).toBe(false)
      }
    }
    for (const from of ["running", "succeeded", "canceled"] as const) {
      const next = cancelOperation(makeOperation({ status: from }), 300)
      expect(Either.isLeft(next)).toBe(true)
      if (Either.isLeft(next)) {
        expect(next.left).toBeInstanceOf(InvalidOperationTransition)
      }
    }
  })

  it("isOperationUnfinished matches the DB partial unique index predicate", () => {
    // 「unfinished」 = status NOT IN ('succeeded','canceled')。
    // これを true→false の集合として dev の意味と DB の意味を一致させる。
    expect(isOperationUnfinished(makeOperation({ status: "queued" }))).toBe(true)
    expect(isOperationUnfinished(makeOperation({ status: "running" }))).toBe(true)
    expect(isOperationUnfinished(makeOperation({ status: "failed" }))).toBe(true)
    expect(isOperationUnfinished(makeOperation({ status: "blocked" }))).toBe(true)
    expect(isOperationUnfinished(makeOperation({ status: "succeeded" }))).toBe(false)
    expect(isOperationUnfinished(makeOperation({ status: "canceled" }))).toBe(false)
  })
})

describe("sanitizeOperationError", () => {
  // 「allowlist の tag → 固定 summary + 非機密 canonical キーだけ」。
  // bearer / request body / email / provider の生文字列は絶対に details に
  // 入れない。unknown はすべて external_operation_failed に潰し、tag だけ
  // 記録用に残す。

  it("maps RepoError to storage_unavailable without cause payload", () => {
    class RepoErrorFake extends Data.TaggedError("RepoError")<{ cause: unknown }> {}
    const sanitized = sanitizeOperationError(
      new RepoErrorFake({ cause: new Error("Bearer eyJhbGciOiJIUzI1NiJ9.secret") })
    )
    expect(sanitized.code).toBe("storage_unavailable")
    expect(sanitized.summary).not.toContain("Bearer")
    expect(sanitized.summary).not.toContain("secret")
    // details には bearer/生 cause 文字列を残さない。
    expect(JSON.stringify(sanitized.details)).not.toContain("Bearer")
    expect(JSON.stringify(sanitized.details)).not.toContain("secret")
  })

  it("maps ProxmoxError / CloudflareError / GithubKeysError to provider_unavailable", () => {
    for (const tag of ["ProxmoxError", "CloudflareError", "GithubKeysError"] as const) {
      const sanitized = sanitizeOperationError({ _tag: tag, cause: "should-not-leak" })
      expect(sanitized.code).toBe("provider_unavailable")
      expect(JSON.stringify(sanitized)).not.toContain("should-not-leak")
    }
  })

  it("maps ProvisionTimeout to provider_timeout with only numeric canonical fields", () => {
    const sanitized = sanitizeOperationError({
      _tag: "ProvisionTimeout",
      timeoutMillis: 120_000,
      privateIp: "10.100.1.11" // 内部 IP は canonical キーには乗せない
    })
    expect(sanitized.code).toBe("provider_timeout")
    expect(sanitized.details.timeoutMillis).toBe("120000")
    expect(JSON.stringify(sanitized)).not.toContain("10.100.1.11")
  })

  it("maps InvalidOperationTransition with only from/to canonical keys", () => {
    const sanitized = sanitizeOperationError({
      _tag: "InvalidOperationTransition",
      from: "running",
      to: "queued"
    })
    expect(sanitized.code).toBe("invalid_transition")
    expect(sanitized.details.from).toBe("running")
    expect(sanitized.details.to).toBe("queued")
  })

  it("maps InvalidContestTransition with from/to", () => {
    const sanitized = sanitizeOperationError({
      _tag: "InvalidContestTransition",
      from: "draft",
      to: "running"
    })
    expect(sanitized.code).toBe("invalid_transition")
    expect(sanitized.details.from).toBe("draft")
    expect(sanitized.details.to).toBe("running")
  })

  it("maps ContestRevisionConflict with expected/actual", () => {
    const sanitized = sanitizeOperationError({
      _tag: "ContestRevisionConflict",
      expected: 3,
      actual: 4
    })
    expect(sanitized.code).toBe("revision_conflict")
    expect(sanitized.details.expected).toBe("3")
    expect(sanitized.details.actual).toBe("4")
  })

  it("maps OperationInProgress to conflict without payload", () => {
    const sanitized = sanitizeOperationError({ _tag: "OperationInProgress" })
    expect(sanitized.code).toBe("conflict")
    expect(sanitized.details).toStrictEqual({})
  })

  it("maps unknown causes to external_operation_failed and never stringifies the cause", () => {
    const cause = {
      Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.leak",
      body: { email: "leaked@example.com" }
    }
    const sanitized = sanitizeOperationError(cause)
    expect(sanitized.code).toBe("external_operation_failed")
    expect(JSON.stringify(sanitized)).not.toContain("Bearer")
    expect(JSON.stringify(sanitized)).not.toContain("leaked@example.com")
    expect(JSON.stringify(sanitized)).not.toContain("Authorization")
  })

  it("does not leak an unknown-cause tag verbatim into summary", () => {
    // _tag だけを allowlist 外として扱い、details には残しても summary に
    // provider の raw 文字列を混ぜない(summary は allowlist 固定文言だけ)。
    const sanitized = sanitizeOperationError({ _tag: "SomeProviderBoom", extra: "secret-payload" })
    expect(sanitized.code).toBe("external_operation_failed")
    expect(sanitized.summary).not.toContain("secret-payload")
    expect(sanitized.summary).not.toContain("SomeProviderBoom")
    // 記録用の redacted tag は details.tag に載せてよいが、raw payload は不可。
    expect(JSON.stringify(sanitized)).not.toContain("secret-payload")
  })
})
