import { SqlClient } from "@effect/sql"
import { Clock, Effect, Either, Layer, Option, Schema } from "effect"
import type { SqlError } from "@effect/sql/SqlError"
import { InvalidOperationTransition } from "../../../domain/errors.js"
import type { OperationId, OperationStepId } from "../../../domain/ids.js"
import { Operation, OperationStep, SanitizedOperationError } from "../../../domain/operation.js"
import type { NewOperation } from "../../../domain/operation.js"
import {
  OperationInProgress,
  OperationRepo,
  OperationWorkerConfig,
  RepoError,
  UuidGen
} from "../../../application/ports.js"
import { decodeRow, wrapSqlError } from "./support.js"

// SQLite driver は SqlError の cause 連鎖の中で "UNIQUE constraint failed: ..."
// メッセージを載せてくる。partial unique index の race を typed error に落と
// すために、cause 連鎖を再帰的に潜って message string を取り出す
// (contestRepo.ts の同名 helper と同じ形式)。
const extractSqlErrorMessage = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "object" && cause !== null) {
    const withCause = cause as { message?: unknown; cause?: unknown }
    if (typeof withCause.message === "string") return withCause.message
    if (withCause.cause !== undefined) return extractSqlErrorMessage(withCause.cause)
  }
  return String(cause)
}

// operations / operation_steps テーブルを対象にした atomic transition 実装。
//
// - enqueue: 「他に unfinished Operation あり」または「creating/deleting な
//   Instance あり」の 2 つの cross-lock を SQL 側で先取り検査 → INSERT を
//   同一 sql.withTransaction に閉じ込める。partial unique index が最終的な
//   強制点(2 admin が同時に来ても DB 側の一意違反で 1 つだけ通る)。
// - claimNext: 「実行可能な次 Step」を単一 UPDATE ... WHERE ... RETURNING で
//   拾う。同 Operation で running Step があればスキップ、preceding failed/
//   blocked (continue_on_error=0) があればスキップ、retry_at <= now、lease
//   期限切れ or NULL、queued 状態、を条件に組む。UPDATE の副作用として
//   attempt+=1、status=running、started_at=now、lease_expires_at=now+LEASE。
// - completeStep / failStep / blockStep: step の状態遷移を単一 UPDATE で
//   行い、その直後に Operation 全体の再評価(reevaluateOperation)を回す。
// - resumeExpired: worker 再起動時のロスト step 補償。cutoff 以前に lease
//   期限が切れた running Step を queued に戻す(attempt は保持、次 claim で +1)。
// - retry / cancel: operator 操作。retry は failed/blocked → running(残 step は
//   queued に戻す)。cancel は running Step があると拒否、それ以外で canceled 化。

interface OperationRow {
  readonly id: string
  readonly contestId: string
  readonly kind: string
  readonly status: string
  readonly actorKind: string
  readonly actorUserId: string | null
  readonly planDigest: string
  readonly contestRevision: number
  readonly sanitizedError: string | null
  readonly createdAt: number
  readonly startedAt: number | null
  readonly finishedAt: number | null
}

interface StepRow {
  readonly id: string
  readonly operationId: string
  readonly ordinal: number
  readonly stepKey: string
  readonly status: string
  readonly attempt: number
  readonly continueOnError: number
  readonly retryAt: number | null
  readonly leaseExpiresAt: number | null
  readonly inputSummary: string
  readonly progressJson: string
  readonly resultSummary: string | null
  readonly sanitizedError: string | null
  readonly createdAt: number
  readonly startedAt: number | null
  readonly finishedAt: number | null
}

const OP_COLUMNS = `
  id, contest_id AS contestId, kind, status,
  actor_kind AS actorKind, actor_user_id AS actorUserId,
  plan_digest AS planDigest, contest_revision AS contestRevision,
  sanitized_error AS sanitizedError,
  created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt
`

const STEP_COLUMNS = `
  id, operation_id AS operationId, ordinal, step_key AS stepKey, status, attempt,
  continue_on_error AS continueOnError, retry_at AS retryAt, lease_expires_at AS leaseExpiresAt,
  input_summary AS inputSummary, progress_json AS progressJson,
  result_summary AS resultSummary, sanitized_error AS sanitizedError,
  created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt
`

// JOIN operations の際に id / status 列が衝突するため s. で qualify した版を
// 分けて持つ(operationRepo 内でのみ使用)。
const STEP_COLUMNS_S = `
  s.id, s.operation_id AS operationId, s.ordinal, s.step_key AS stepKey, s.status AS status,
  s.attempt, s.continue_on_error AS continueOnError, s.retry_at AS retryAt,
  s.lease_expires_at AS leaseExpiresAt, s.input_summary AS inputSummary,
  s.progress_json AS progressJson, s.result_summary AS resultSummary,
  s.sanitized_error AS sanitizedError, s.created_at AS createdAt,
  s.started_at AS startedAt, s.finished_at AS finishedAt
`

// sanitized_error は DB TEXT (JSON.stringify) と domain SanitizedOperationError
// (object) の双方向変換を repo が担う。domain 側は Option<SanitizedOperationError>。
// 各フィールドの型まで検証するために Schema.decodeUnknownEither に通す
// (単なる key 存在チェックだと {"code": 42, "summary": null} のような型異常が
// 通り抜けて下流で TypeError になる。migration や外部編集で壊された行を
// 静かに握って null にすることで、想定外 payload を Operation の運用停止に
// 波及させない)。
const decodeSanitizedError = Schema.decodeUnknownEither(SanitizedOperationError)
const parseSanitizedError = (raw: string | null): SanitizedOperationError | null => {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const result = decodeSanitizedError(parsed)
  return Either.isRight(result) ? result.right : null
}

const buildActor = (row: OperationRow): Operation["actor"] =>
  row.actorKind === "admin" && row.actorUserId !== null
    ? { kind: "admin", userId: row.actorUserId as Operation["actor"] extends { userId: infer U } ? U : never }
    : { kind: "scheduler" }

const decodeOperation = (row: OperationRow): Effect.Effect<Operation, RepoError> =>
  decodeRow(Operation, {
    ...row,
    actor: buildActor(row),
    sanitizedError: parseSanitizedError(row.sanitizedError)
  })

const decodeStep = (row: StepRow): Effect.Effect<OperationStep, RepoError> =>
  decodeRow(OperationStep, {
    ...row,
    continueOnError: row.continueOnError === 1,
    sanitizedError: parseSanitizedError(row.sanitizedError)
  })

export const OperationRepoLive: Layer.Layer<
  OperationRepo,
  never,
  SqlClient.SqlClient | UuidGen | OperationWorkerConfig
> = Layer.effect(
  OperationRepo,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const uuidGen = yield* UuidGen
    const workerConfig = yield* OperationWorkerConfig
    const opColumns = sql.literal(OP_COLUMNS)
    const stepColumns = sql.literal(STEP_COLUMNS)
    const stepColumnsS = sql.literal(STEP_COLUMNS_S)

    // Operation の再評価: step 集合から Operation 全体の terminal 状態を推す。
    // - running/queued (retryAt 未来含む)Step が 1 件でも残る → running のまま
    // - blocked Step が 1 件でもある → blocked
    // - continue_on_error=0 の failed Step があり、後続 queued/running が
    //   スキップされて 0 に落ち着いたとき → failed
    // - continue_on_error=true の failed Step があるが他は全 succeeded → failed
    // - 全 succeeded → succeeded
    // finished_at は succeeded / failed / blocked / canceled のいずれかに落ちた瞬間に刻む
    // (blocked は operator 対応待ちなので finished_at は None が仕様上妥当だが、
    //  再評価は「同じ状態への転記」を許容するため副作用なし)。
    const reevaluateOperation = (operationId: string, now: number) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          status: string
          continueOnError: number
          ordinal: number
        }>`
          SELECT status, continue_on_error AS continueOnError, ordinal
          FROM operation_steps WHERE operation_id = ${operationId}
        `
        if (rows.length === 0) return

        const anyBlocked = rows.some((r) => r.status === "blocked")
        const anyFailedHalting = rows.some((r) => r.status === "failed" && r.continueOnError === 0)
        const anyRunning = rows.some((r) => r.status === "running")
        const anyQueued = rows.some((r) => r.status === "queued")
        const anyFailedContinue = rows.some((r) => r.status === "failed" && r.continueOnError === 1)
        const allSucceeded = rows.every((r) => r.status === "succeeded")

        // 生きた step が 1 つでも残る限り Operation は running を維持する。
        // ただし blocked / halting-failed が確定した瞬間は残 step を無視して
        // Operation を終了状態に落とす(claimNext 側でも同じ predicate で
        // 後続 step を止める)。
        // blocked への遷移では finished_at を触らない(domain の
        // markOperationBlocked は operator 対応待ちを意味し finishedAt を
        // 立てないため; retry で running に戻す際も finished_at をクリアする
        // 挙動と整合する)。
        // markOperationBlocked / markOperationFailed が domain 側で
        // sanitized_error を Operation aggregate に載せる契約なので、SQL 側
        // でも step の sanitized_error を Operation 行に伝搬させる。ordinal
        // 順で最初に該当した step の error を採用する(先に失敗した step が
        // 全体の原因として最も情報量が多い)。
        if (anyBlocked) {
          yield* sql`
            UPDATE operations
            SET status = 'blocked',
                sanitized_error = (
                  SELECT sanitized_error FROM operation_steps
                  WHERE operation_id = ${operationId} AND status = 'blocked'
                  ORDER BY ordinal ASC LIMIT 1
                )
            WHERE id = ${operationId} AND status = 'running'
          `
          return
        }
        if (anyFailedHalting) {
          yield* sql`
            UPDATE operations
            SET status = 'failed',
                finished_at = COALESCE(finished_at, ${now}),
                sanitized_error = (
                  SELECT sanitized_error FROM operation_steps
                  WHERE operation_id = ${operationId}
                    AND status = 'failed' AND continue_on_error = 0
                  ORDER BY ordinal ASC LIMIT 1
                )
            WHERE id = ${operationId} AND status = 'running'
          `
          return
        }
        // まだ実行中の step があるので transition しない。
        if (anyRunning || anyQueued) return

        if (allSucceeded) {
          // succeed 経路では過去の失敗 error を残さない(retry → succeed の
          // 遷移で古い sanitized_error が残ると監視 UI が誤検知するため)。
          yield* sql`
            UPDATE operations
            SET status = 'succeeded',
                finished_at = COALESCE(finished_at, ${now}),
                sanitized_error = NULL
            WHERE id = ${operationId} AND status = 'running'
          `
          return
        }
        if (anyFailedContinue) {
          yield* sql`
            UPDATE operations
            SET status = 'failed',
                finished_at = COALESCE(finished_at, ${now}),
                sanitized_error = (
                  SELECT sanitized_error FROM operation_steps
                  WHERE operation_id = ${operationId} AND status = 'failed'
                  ORDER BY ordinal ASC LIMIT 1
                )
            WHERE id = ${operationId} AND status = 'running'
          `
        }
      })

    return {
      enqueue: (input: NewOperation) =>
        wrapSqlError(
          sql.withTransaction(
            Effect.gen(function* () {
              // 0-step Operation は永久に unfinished lock を掴んだままになる
              // (claimNext は候補 0 → 何もしない、reevaluateOperation は step
              // イベントからしか呼ばれない)ため、enqueue の入口で defect に
              // 落とす。呼び出し規約バグを表面化させて operator が cancel を
              // 打たなければ復旧できない状態に陥らないようにする。
              if (input.steps.length === 0) {
                return yield* Effect.dieMessage(
                  `enqueue: NewOperation for kind '${input.kind}' has zero steps; this would permanently hold the global unfinished-Operation lock`
                )
              }
              // Cross-lock (Operation ↔ Instance) の先取り: creating/deleting な
              // Instance があると self-service セマフォと重なり、Operation の
              // 内部 step が同じ VM を触りにいくと二重処理になる。SQL 側で
              // ここで検出して OperationInProgress にする(TeamJobAlreadyQueued
              // と同型 - リポジトリが原子的に検出)。
              const inflightInstances = yield* sql<{ id: string }>`
                SELECT id FROM instances WHERE status IN ('creating','deleting') LIMIT 1
              `
              if (inflightInstances.length > 0) {
                return yield* Effect.fail(new OperationInProgress())
              }

              // 単一 unfinished Operation の先取り。最後は partial unique index が
              // 強制するが、typed error にするためここでも読む。
              const inflightOps = yield* sql<{ id: string }>`
                SELECT id FROM operations WHERE status NOT IN ('succeeded','canceled') LIMIT 1
              `
              if (inflightOps.length > 0) {
                return yield* Effect.fail(new OperationInProgress())
              }

              const now = yield* Clock.currentTimeMillis
              const opId = yield* uuidGen.next
              // 2 admin が SELECT の先取りを同時に通り抜けた場合、片方の
              // INSERT は partial unique index (idx_operations_single_unfinished)
              // で SQLite constraint violation になる。wrapSqlError の
              // デフォルト経路だと RepoError (500 化) になってしまうため、
              // ここで SqlError を捕まえて typed OperationInProgress に落とす
              // (ContestRepo.create の partial unique 診断と同じ手法)。
              yield* sql`
                INSERT INTO operations (
                  id, contest_id, kind, status, actor_kind, actor_user_id,
                  plan_digest, contest_revision, sanitized_error,
                  created_at, started_at, finished_at
                ) VALUES (
                  ${opId}, ${input.contestId}, ${input.kind}, 'queued',
                  ${input.actor.kind},
                  ${input.actor.kind === "admin" ? input.actor.userId : null},
                  ${input.planDigest}, ${input.contestRevision}, NULL,
                  ${now}, NULL, NULL
                )
              `.pipe(
                Effect.catchTag(
                  "SqlError",
                  (cause): Effect.Effect<never, OperationInProgress | SqlError> => {
                    const message = extractSqlErrorMessage(cause)
                    if (message.includes("UNIQUE constraint failed")) {
                      return Effect.fail(new OperationInProgress())
                    }
                    return Effect.fail(cause)
                  }
                )
              )

              for (const step of input.steps) {
                const stepId = yield* uuidGen.next
                yield* sql`
                  INSERT INTO operation_steps (
                    id, operation_id, ordinal, step_key, status, attempt,
                    continue_on_error, retry_at, lease_expires_at,
                    input_summary, progress_json, result_summary, sanitized_error,
                    created_at, started_at, finished_at
                  ) VALUES (
                    ${stepId}, ${opId}, ${step.ordinal}, ${step.stepKey}, 'queued', 0,
                    ${step.continueOnError ? 1 : 0}, NULL, NULL,
                    ${step.inputSummary}, '{}', NULL, NULL,
                    ${now}, NULL, NULL
                  )
                `
              }

              const rows = yield* sql<OperationRow>`
                SELECT ${opColumns} FROM operations WHERE id = ${opId}
              `
              return yield* decodeOperation(rows[0])
            })
          )
        ),

      findById: (id: OperationId) =>
        wrapSqlError(sql<OperationRow>`SELECT ${opColumns} FROM operations WHERE id = ${id}`).pipe(
          Effect.flatMap((rows) =>
            rows.length === 0
              ? Effect.succeed(Option.none<Operation>())
              : decodeOperation(rows[0]).pipe(Effect.map(Option.some))
          )
        ),

      listSteps: (id: OperationId) =>
        wrapSqlError(
          sql<StepRow>`SELECT ${stepColumns} FROM operation_steps WHERE operation_id = ${id} ORDER BY ordinal`
        ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, decodeStep))),

      // claimNext: unfinished operation の中で「先行するハルト条件が無く」
      // 「retry_at <= now」で「queued」な最小 ordinal Step を 1 件だけ拾い、
      // running に遷移させる。ordering:
      //   1. operation.created_at, operation.id  ← FIFO
      //   2. step.ordinal
      claimNext: (now: number) =>
        wrapSqlError(
          sql.withTransaction(
            Effect.gen(function* () {
              const candidates = yield* sql<StepRow & { opCreatedAt: number; opStatus: string }>`
                SELECT ${stepColumnsS}, o.created_at AS opCreatedAt, o.status AS opStatus
                FROM operation_steps s
                JOIN operations o ON o.id = s.operation_id
                WHERE o.status NOT IN ('succeeded','canceled','blocked','failed')
                  AND s.status = 'queued'
                  AND (s.retry_at IS NULL OR s.retry_at <= ${now})
                  -- 同 Operation の running Step が無い
                  AND NOT EXISTS (
                    SELECT 1 FROM operation_steps s2
                    WHERE s2.operation_id = s.operation_id AND s2.status = 'running'
                  )
                  -- 先行する halting-failed / blocked Step が無い
                  AND NOT EXISTS (
                    SELECT 1 FROM operation_steps s3
                    WHERE s3.operation_id = s.operation_id
                      AND s3.ordinal < s.ordinal
                      AND (
                        s3.status = 'blocked'
                        OR (s3.status = 'failed' AND s3.continue_on_error = 0)
                      )
                  )
                ORDER BY o.created_at ASC, o.id ASC, s.ordinal ASC
                LIMIT 1
              `
              if (candidates.length === 0) return Option.none<OperationStep>()

              const chosen = candidates[0]
              const lease = now + workerConfig.leaseDurationMillis
              const updated = yield* sql<StepRow>`
                UPDATE operation_steps
                SET status = 'running',
                    attempt = attempt + 1,
                    started_at = COALESCE(started_at, ${now}),
                    lease_expires_at = ${lease},
                    retry_at = NULL
                WHERE id = ${chosen.id} AND status = 'queued'
                RETURNING ${stepColumns}
              `
              if (updated.length === 0) return Option.none<OperationStep>()

              // Operation も (queued → running) にする(初回 claim 時のみ実効)。
              yield* sql`
                UPDATE operations
                SET status = 'running', started_at = COALESCE(started_at, ${now})
                WHERE id = ${chosen.operationId} AND status = 'queued'
              `

              return yield* decodeStep(updated[0]).pipe(Effect.map(Option.some))
            })
          )
        ),

      completeStep: (stepId: OperationStepId, summary: string, now: number) =>
        wrapSqlError(
          sql.withTransaction(
            Effect.gen(function* () {
              const rows = yield* sql<{ operationId: string }>`
                UPDATE operation_steps
                SET status = 'succeeded', result_summary = ${summary},
                    finished_at = ${now}, lease_expires_at = NULL, sanitized_error = NULL
                WHERE id = ${stepId} AND status = 'running'
                RETURNING operation_id AS operationId
              `
              if (rows.length === 0) return
              yield* reevaluateOperation(rows[0].operationId, now)
            })
          )
        ).pipe(Effect.asVoid),

      failStep: (
        stepId: OperationStepId,
        error: SanitizedOperationError,
        retryAt: Option.Option<number>,
        now: number
      ) =>
        wrapSqlError(
          sql.withTransaction(
            Effect.gen(function* () {
              const errJson = JSON.stringify(error)
              if (Option.isSome(retryAt)) {
                // 再スケジュール: status を queued に戻し、retry_at を刻む。attempt は
                // 保持(次 claim で +1)。lease は解放する。
                yield* sql`
                  UPDATE operation_steps
                  SET status = 'queued', retry_at = ${retryAt.value},
                      lease_expires_at = NULL, sanitized_error = ${errJson}
                  WHERE id = ${stepId} AND status = 'running'
                `
                return
              }
              const rows = yield* sql<{ operationId: string }>`
                UPDATE operation_steps
                SET status = 'failed', finished_at = ${now},
                    lease_expires_at = NULL, sanitized_error = ${errJson}
                WHERE id = ${stepId} AND status = 'running'
                RETURNING operation_id AS operationId
              `
              if (rows.length === 0) return
              // continueOnError=false のとき reevaluateOperation で失敗確定、
              // true なら他 Step の完了を待って final に落とす。
              yield* reevaluateOperation(rows[0].operationId, now)
            })
          )
        ).pipe(Effect.asVoid),

      blockStep: (stepId: OperationStepId, error: SanitizedOperationError, now: number) =>
        wrapSqlError(
          sql.withTransaction(
            Effect.gen(function* () {
              const errJson = JSON.stringify(error)
              const rows = yield* sql<{ operationId: string }>`
                UPDATE operation_steps
                SET status = 'blocked', finished_at = ${now},
                    lease_expires_at = NULL, sanitized_error = ${errJson}
                WHERE id = ${stepId} AND status = 'running'
                RETURNING operation_id AS operationId
              `
              if (rows.length === 0) return
              yield* reevaluateOperation(rows[0].operationId, now)
            })
          )
        ).pipe(Effect.asVoid),

      resumeExpired: (cutoff: number) =>
        wrapSqlError(
          sql<{ id: string }>`
            UPDATE operation_steps
            SET status = 'queued', lease_expires_at = NULL
            WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ${cutoff}
            RETURNING id
          `
        ).pipe(Effect.map((rows) => rows.length)),

      retry: (operationId: OperationId, now: number) =>
        wrapSqlError(
          sql.withTransaction(
            Effect.gen(function* () {
              const current = yield* sql<{ status: string }>`
                SELECT status FROM operations WHERE id = ${operationId}
              `
              if (current.length === 0) {
                // 呼び出し元(admin API)は retry の前に findById で 404 を返す
                // 責務を持つ。ここに到達するのは「取得直後に別 admin が cascade
                // 削除した」等の想定外レースであり、状態機械の不正遷移とは異なる。
                // 誤解を招く InvalidOperationTransition を返さず defect にする。
                return yield* Effect.dieMessage(`retry: operation ${operationId} row disappeared`)
              }
              const from = current[0].status
              if (from !== "failed" && from !== "blocked") {
                return yield* Effect.fail(
                  new InvalidOperationTransition({
                    from: from as Operation["status"],
                    to: "running"
                  })
                )
              }

              // TOCTOU 対策: WHERE に status ガードを付け、affected rows で
              // 「pre-check の SELECT と UPDATE の間に他の tx が状態を書き換えた」
              // ケースを検出する。ガードなしだと 2 並列 retry の 2 本目が worker
              // が transition 済み ('succeeded' 等) の Operation を running に
              // 上書きし、queued/running な step が無い恒久 lock ホルダーが生まれる。
              const affected = yield* sql<{ id: string }>`
                UPDATE operations
                SET status = 'running', finished_at = NULL, sanitized_error = NULL
                WHERE id = ${operationId} AND status IN ('failed','blocked')
                RETURNING id
              `
              if (affected.length === 0) {
                return yield* Effect.fail(
                  new InvalidOperationTransition({
                    from: from as Operation["status"],
                    to: "running"
                  })
                )
              }
              // failed / blocked Step を queued に戻す(succeeded は保持)。attempt
              // はリセットせず引き継ぐ(operator の再試行意図)。retry_at はクリア。
              yield* sql`
                UPDATE operation_steps
                SET status = 'queued', retry_at = NULL, lease_expires_at = NULL,
                    finished_at = NULL, sanitized_error = NULL
                WHERE operation_id = ${operationId} AND status IN ('failed','blocked')
              `

              const rows = yield* sql<OperationRow>`
                SELECT ${opColumns} FROM operations WHERE id = ${operationId}
              `
              return yield* decodeOperation(rows[0])
            })
          )
        ),

      cancel: (operationId: OperationId, now: number) =>
        wrapSqlError(
          sql.withTransaction(
            Effect.gen(function* () {
              // cancel は「running な step が無い」ことを SQL 条件に組み込む。
              // step が running のときに canceled 化すると外部 mutation の
              // 結果を失うため、operator は明示的に retry/step-complete/fail の
              // どちらかで先に片付ける必要がある。
              const runningStep = yield* sql<{ id: string }>`
                SELECT id FROM operation_steps
                WHERE operation_id = ${operationId} AND status = 'running' LIMIT 1
              `
              const current = yield* sql<{ status: string }>`
                SELECT status FROM operations WHERE id = ${operationId}
              `
              if (current.length === 0) {
                // retry と同型: 直前に findById で 404 を返す呼び出し規約。
                // ここに来るのは想定外レースなので defect(Contest saveIfRevision
                // が採る「row disappeared」パターンと同じ)。
                return yield* Effect.dieMessage(`cancel: operation ${operationId} row disappeared`)
              }
              const from = current[0].status as Operation["status"]
              if (
                from === "running" ||
                from === "succeeded" ||
                from === "canceled" ||
                runningStep.length > 0
              ) {
                return yield* Effect.fail(
                  new InvalidOperationTransition({ from, to: "canceled" })
                )
              }

              // TOCTOU 対策: retry 側と同型。SELECT と UPDATE の間に別 tx が
              // 状態を書き換えた場合(concurrent retry など)、canceled 化を
              // 上書きしないようステータス集合を WHERE に持ち込み、affected
              // rows が 0 なら InvalidOperationTransition に落とす。
              const affected = yield* sql<{ id: string }>`
                UPDATE operations SET status = 'canceled', finished_at = ${now}
                WHERE id = ${operationId} AND status IN ('queued','failed','blocked')
                RETURNING id
              `
              if (affected.length === 0) {
                return yield* Effect.fail(
                  new InvalidOperationTransition({ from, to: "canceled" })
                )
              }
              // まだ queued の step が残っていると listSteps が「実行可能に見える
              // が絶対に実行されない」ゴミ行を返し続ける(claimNext は canceled
              // operation を無視するため実害はないが、monitoring / operator UI
              // が誤解する)。cancel 時点で queued は失敗扱いにして terminal
              // に落とし、sanitized_error に canceled を印字する。
              const cancelErr = JSON.stringify({
                code: "canceled",
                summary: "operation was canceled before this step ran",
                details: {}
              })
              yield* sql`
                UPDATE operation_steps
                SET status = 'failed', finished_at = ${now}, sanitized_error = ${cancelErr}
                WHERE operation_id = ${operationId} AND status = 'queued'
              `
              const rows = yield* sql<OperationRow>`
                SELECT ${opColumns} FROM operations WHERE id = ${operationId}
              `
              return yield* decodeOperation(rows[0])
            })
          )
        )
    }
  })
)
