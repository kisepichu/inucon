import { Either, Option, Schema } from "effect"
import { InvalidOperationTransition } from "./errors.js"
import { ContestId, OperationId, OperationStepId, UserId } from "./ids.js"

// Task 6: Durable Operation の状態機械と sanitizeOperationError。
//
// - Operation: グローバル単一 unfinished(status NOT IN succeeded/canceled)
//   を Repository の partial unique index で強制する。ドメインでは
//   isOperationUnfinished が同じ判定式を返し、SQL 側の predicate と
//   同意味を保つ(review invariant: DB と code のセマンティクスを一致させる)。
// - Step: (queued → running → succeeded|failed|blocked) のうち failed / blocked
//   は Operation を halt する。continueOnError=true の Step が失敗した場合は
//   次 Step が実行されるが、Operation は最終的に failed に落ちる。
// - sanitizeOperationError: allowlist の _tag → 固定 summary + 非機密の
//   canonical キーだけを details に詰める。unknown は external_operation_failed
//   に潰し、cause 文字列/bearer/email/request body を絶対に残さない。

// スキーマの列挙値を単一の source-of-truth にする(タプル → Schema.Literal と
// TypeScript の union 型の両方に使う)。
export const OPERATION_KINDS = [
  "reconcile",
  "enter_contest_mode",
  "prepare",
  "start",
  "finish",
  "revoke_access",
  "cleanup",
  "return_normal_mode",
  "backup"
] as const
export type OperationKind = (typeof OPERATION_KINDS)[number]

export const OPERATION_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "canceled"
] as const
export type OperationStatus = (typeof OPERATION_STATUSES)[number]

export const OPERATION_STEP_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "blocked"
] as const
export type OperationStepStatus = (typeof OPERATION_STEP_STATUSES)[number]

// OperationActor: admin と scheduler の discriminated union。admin は必ず
// userId を持つ(DB CHECK 側でも actor_kind='admin' → actor_user_id NOT NULL
// を強制する)。
export const OperationActor = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("admin"), userId: UserId }),
  Schema.Struct({ kind: Schema.Literal("scheduler") })
)
export type OperationActor = typeof OperationActor.Type

// SanitizedOperationError: allowlist に載る固定 code / summary / canonical
// details(値は全て string に落として型を狭く保つ)。DB には JSON.stringify
// した結果を TEXT で格納する。
export const SanitizedOperationError = Schema.Struct({
  code: Schema.String,
  summary: Schema.String,
  details: Schema.Record({ key: Schema.String, value: Schema.String })
})
export type SanitizedOperationError = typeof SanitizedOperationError.Type

// Operation 集約(集約ルート)。sanitizedError はドメインでは Option、
// wire/DB では null (JSON.stringify | null) で表現する。
export class Operation extends Schema.Class<Operation>("Operation")({
  id: OperationId,
  contestId: ContestId,
  kind: Schema.Literal(...OPERATION_KINDS),
  status: Schema.Literal(...OPERATION_STATUSES),
  actor: OperationActor,
  planDigest: Schema.String,
  contestRevision: Schema.Int.pipe(Schema.positive()),
  sanitizedError: Schema.OptionFromNullOr(SanitizedOperationError),
  createdAt: Schema.Int,
  startedAt: Schema.OptionFromNullOr(Schema.Int),
  finishedAt: Schema.OptionFromNullOr(Schema.Int)
}) {}

// OperationStep: Operation に紐づく実行単位。stepKey は Operation 内一意、
// ordinal は claim 順を決める。
export class OperationStep extends Schema.Class<OperationStep>("OperationStep")({
  id: OperationStepId,
  operationId: OperationId,
  ordinal: Schema.Int.pipe(Schema.nonNegative()),
  stepKey: Schema.String,
  status: Schema.Literal(...OPERATION_STEP_STATUSES),
  attempt: Schema.Int.pipe(Schema.nonNegative()),
  continueOnError: Schema.Boolean,
  retryAt: Schema.OptionFromNullOr(Schema.Int),
  leaseExpiresAt: Schema.OptionFromNullOr(Schema.Int),
  inputSummary: Schema.String,
  progressJson: Schema.String,
  resultSummary: Schema.OptionFromNullOr(Schema.String),
  sanitizedError: Schema.OptionFromNullOr(SanitizedOperationError),
  createdAt: Schema.Int,
  startedAt: Schema.OptionFromNullOr(Schema.Int),
  finishedAt: Schema.OptionFromNullOr(Schema.Int)
}) {}

// SQL 側 partial unique(WHERE status NOT IN ('succeeded','canceled'))と
// 同じ意味論。ここを 1 箇所にすることで、application 層のガード判断・
// domain テスト・DB 側 predicate が一致する。
export const isOperationUnfinished = (op: Operation): boolean =>
  op.status !== "succeeded" && op.status !== "canceled"

const bump = (op: Operation, fields: Partial<Operation>): Operation =>
  new Operation({ ...op, ...fields })

// queued → running。startedAt を刻む。
export const markOperationRunning = (
  op: Operation,
  now: number
): Either.Either<Operation, InvalidOperationTransition> =>
  op.status === "queued"
    ? Either.right(bump(op, { status: "running", startedAt: Option.some(now) }))
    : Either.left(new InvalidOperationTransition({ from: op.status, to: "running" }))

// running → succeeded。finishedAt を刻む。
export const completeOperation = (
  op: Operation,
  now: number
): Either.Either<Operation, InvalidOperationTransition> =>
  op.status === "running"
    ? Either.right(bump(op, { status: "succeeded", finishedAt: Option.some(now) }))
    : Either.left(new InvalidOperationTransition({ from: op.status, to: "succeeded" }))

// running → failed。finishedAt を刻み、sanitizedError を残す。
export const markOperationFailed = (
  op: Operation,
  error: SanitizedOperationError,
  now: number
): Either.Either<Operation, InvalidOperationTransition> =>
  op.status === "running"
    ? Either.right(
        bump(op, {
          status: "failed",
          finishedAt: Option.some(now),
          sanitizedError: Option.some(error)
        })
      )
    : Either.left(new InvalidOperationTransition({ from: op.status, to: "failed" }))

// running → blocked。finishedAt は打たない(operator 対応待ち)、sanitizedError を残す。
export const markOperationBlocked = (
  op: Operation,
  error: SanitizedOperationError,
  _now: number
): Either.Either<Operation, InvalidOperationTransition> =>
  op.status === "running"
    ? Either.right(bump(op, { status: "blocked", sanitizedError: Option.some(error) }))
    : Either.left(new InvalidOperationTransition({ from: op.status, to: "blocked" }))

// queued/failed/blocked → canceled。running/succeeded/canceled からは不可。
export const cancelOperation = (
  op: Operation,
  now: number
): Either.Either<Operation, InvalidOperationTransition> =>
  op.status === "queued" || op.status === "failed" || op.status === "blocked"
    ? Either.right(bump(op, { status: "canceled", finishedAt: Option.some(now) }))
    : Either.left(new InvalidOperationTransition({ from: op.status, to: "canceled" }))

// sanitizeOperationError: allowlist の _tag に基づいて固定 code / summary
// + 非機密 details を組み立てる。unknown は external_operation_failed に潰す。
//
// 記録として残してよいのは「型として明示的にコードで参照している」フィールドの
// 名前と、それを String() で丸めた値だけ。bearer/authorization/email/request
// body / provider の生 message は絶対に details や summary に残さない。

type CauseObject = { readonly _tag?: unknown; readonly [key: string]: unknown }

const asObject = (cause: unknown): CauseObject | null =>
  typeof cause === "object" && cause !== null ? (cause as CauseObject) : null

const tagOf = (cause: unknown): string | null => {
  const obj = asObject(cause)
  if (obj === null) return null
  return typeof obj._tag === "string" ? obj._tag : null
}

const stringField = (cause: CauseObject, key: string): string | null => {
  const v = cause[key]
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return String(v)
  }
  return null
}

export const sanitizeOperationError = (cause: unknown): SanitizedOperationError => {
  const tag = tagOf(cause)
  const obj = asObject(cause)

  // allowlist の tag ごとに固定 summary と canonical キーだけを残す。
  if (tag === "RepoError") {
    return { code: "storage_unavailable", summary: "database not available", details: {} }
  }

  if (tag === "ProxmoxError" || tag === "CloudflareError" || tag === "GithubKeysError") {
    return {
      code: "provider_unavailable",
      summary: "external provider call failed",
      details: { provider: tag.replace(/Error$/, "").toLowerCase() }
    }
  }

  if (tag === "ProvisionTimeout" && obj !== null) {
    const details: Record<string, string> = {}
    const millis = stringField(obj, "timeoutMillis")
    if (millis !== null) details.timeoutMillis = millis
    return { code: "provider_timeout", summary: "provider operation timed out", details }
  }

  if ((tag === "InvalidOperationTransition" || tag === "InvalidContestTransition") && obj !== null) {
    const details: Record<string, string> = {}
    const from = stringField(obj, "from")
    const to = stringField(obj, "to")
    if (from !== null) details.from = from
    if (to !== null) details.to = to
    return { code: "invalid_transition", summary: "state transition not allowed", details }
  }

  if (tag === "InvalidContestSchedule" && obj !== null) {
    const details: Record<string, string> = {}
    const reason = stringField(obj, "reason")
    if (reason !== null) details.reason = reason
    return { code: "invalid_schedule", summary: "contest schedule invalid", details }
  }

  if (tag === "ContestRevisionConflict" && obj !== null) {
    const details: Record<string, string> = {}
    const expected = stringField(obj, "expected")
    const actual = stringField(obj, "actual")
    if (expected !== null) details.expected = expected
    if (actual !== null) details.actual = actual
    return { code: "revision_conflict", summary: "contest revision conflict", details }
  }

  if (tag === "ContestNotFound") {
    return { code: "not_found", summary: "contest not found", details: {} }
  }

  if (tag === "ContestEditionConflict" && obj !== null) {
    const details: Record<string, string> = {}
    const edition = stringField(obj, "edition")
    if (edition !== null) details.edition = edition
    return { code: "conflict", summary: "contest edition conflict", details }
  }

  if (tag === "OperationalContestConflict") {
    return { code: "conflict", summary: "operational contest conflict", details: {} }
  }

  if (tag === "OperationInProgress") {
    return { code: "conflict", summary: "operation already in progress", details: {} }
  }

  // unknown: tag は canonical フィールドを引かないため、raw payload は捨てて
  // 「external_operation_failed」の固定文言のみ返す。tag すら details に残さない
  // (SomeProviderBoom のような未知 tag が provider の生名を洩らす可能性がある
  // ため、無条件で捨てる)。
  return {
    code: "external_operation_failed",
    summary: "external operation failed",
    details: {}
  }
}

// factory / repo などで新規 Operation を生成するときの入力型。
export interface NewOperation {
  readonly contestId: ContestId
  readonly kind: OperationKind
  readonly actor: OperationActor
  readonly planDigest: string
  readonly contestRevision: number
  readonly steps: ReadonlyArray<NewOperationStep>
}

export interface NewOperationStep {
  readonly stepKey: string
  readonly ordinal: number
  readonly inputSummary: string
  readonly continueOnError: boolean
}
