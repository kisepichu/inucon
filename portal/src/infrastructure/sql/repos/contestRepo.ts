import { SqlClient } from "@effect/sql"
import { Effect, Layer, Option } from "effect"
import { Contest } from "../../../domain/contest.js"
import {
  ContestEditionConflict,
  ContestRevisionConflict,
  OperationalContestConflict
} from "../../../domain/errors.js"
import type { ContestId } from "../../../domain/ids.js"
import { ContestRepo, RepoError } from "../../../application/ports.js"
import { decodeRow, wrapSqlError } from "./support.js"

// Task 3: ContestRepo は複数開催回を持つ contest 履歴を返す正のリポジトリ。
// - list: 全 contest(canceled 含む) を edition 降順で返す(admin ダッシュボード)
// - findById: ID 指定で 1 件(status 問わず)
// - getOperational: preparing/running/finalizing のうち 1 件
//   (0004 の idx_contests_single_operational で最大 1 保証)
// - getDisplay: running/finalizing > 最新 finished > preparing の優先順で
//   1 件返す。canceled は候補外(admin list からのみ辿れる)。
// - create: (edition partial unique + single-operational partial unique) の
//   一意違反を型付きエラーに切り分ける
// - saveIfRevision: 楽観ロック付き更新。SQLite の RETURNING で新 revision を
//   受け取る形にする。expectedRevision と DB 現在値が食い違ったら
//   ContestRevisionConflict(actual を載せて呼び出し元が再取得できるようにする)
const columns = `
  id, edition, name, problem_key AS problemKey, problem_revision AS problemRevision,
  template_vmid AS templateVmid, status, instance_quota AS instanceQuota,
  scheduled_start_at AS scheduledStartAt, scheduled_end_at AS scheduledEndAt,
  access_closes_at AS accessClosesAt, cleanup_at AS cleanupAt,
  access_closed_at AS accessClosedAt, cleanup_completed_at AS cleanupCompletedAt,
  started_at AS startedAt, finalizing_at AS finalizingAt,
  finished_at AS finishedAt, canceled_at AS canceledAt,
  revision
`

// SqlError のメッセージから partial unique index 名を拾って切り分ける。SQLite
// の UNIQUE 制約違反メッセージは `UNIQUE constraint failed: ...` の形式で、
// partial unique index の場合はインデックス名が含まれる(cause 連鎖から掘る)。
const extractMessage = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "object" && cause !== null) {
    const withMessage = cause as { message?: unknown; cause?: unknown }
    if (typeof withMessage.message === "string") return withMessage.message
    if (withMessage.cause !== undefined) return extractMessage(withMessage.cause)
  }
  return String(cause)
}

export const ContestRepoLive: Layer.Layer<ContestRepo, never, SqlClient.SqlClient> = Layer.effect(
  ContestRepo,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient


    return {
      list: wrapSqlError(sql`SELECT ${sql.unsafe(columns)} FROM contests ORDER BY edition DESC, id`).pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeRow(Contest, row)))
      ),

      findById: (id: ContestId) =>
        wrapSqlError(sql`SELECT ${sql.unsafe(columns)} FROM contests WHERE id = ${id}`).pipe(
          Effect.flatMap((rows) =>
            rows.length === 0
              ? Effect.succeed(Option.none<Contest>())
              : decodeRow(Contest, rows[0]).pipe(Effect.map(Option.some))
          )
        ),

      getOperational: wrapSqlError(
        sql`SELECT ${sql.unsafe(columns)} FROM contests WHERE status IN ('preparing','running','finalizing') LIMIT 1`
      ).pipe(
        Effect.flatMap((rows) =>
          rows.length === 0
            ? Effect.succeed(Option.none<Contest>())
            : decodeRow(Contest, rows[0]).pipe(Effect.map(Option.some))
        )
      ),

      // getDisplay の優先順:
      //   1. running / finalizing のいずれか(最大 1)
      //   2. 最新 finished(finished_at DESC → edition DESC)
      //   3. preparing(最大 1)
      // 準備中は最終スコアを消さないため running/finalizing より下位。canceled
      // は表示候補に含めない(admin list からのみ辿れる)。
      // getDisplay は 3 段 SELECT (running/finalizing → 最新 finished →
      // preparing) を順に読むため、間に concurrent write (preparing→running
      // 等) が挟まると snapshot がずれて全部 miss = None → 404 になる narrow
      // な race がある。sql.withTransaction で単一 snapshot に閉じ込める。
      getDisplay: sql.withTransaction(
        Effect.gen(function* () {
          // 1
          const opRows = yield* wrapSqlError(
            sql`SELECT ${sql.unsafe(columns)} FROM contests WHERE status IN ('running','finalizing') LIMIT 1`
          )
          if (opRows.length > 0) return yield* decodeRow(Contest, opRows[0]).pipe(Effect.map(Option.some))

          // 2
          const finRows = yield* wrapSqlError(
            sql`SELECT ${sql.unsafe(columns)} FROM contests WHERE status = 'finished' ORDER BY finished_at DESC, edition DESC LIMIT 1`
          )
          if (finRows.length > 0) return yield* decodeRow(Contest, finRows[0]).pipe(Effect.map(Option.some))

          // 3
          const prepRows = yield* wrapSqlError(
            sql`SELECT ${sql.unsafe(columns)} FROM contests WHERE status = 'preparing' LIMIT 1`
          )
          if (prepRows.length > 0) return yield* decodeRow(Contest, prepRows[0]).pipe(Effect.map(Option.some))

          return Option.none<Contest>()
        })
      ).pipe(Effect.catchTag("SqlError", (cause) => Effect.fail(new RepoError({ cause })))),

      // partial unique index 違反を型付きエラーへ分岐する。SqlError の cause から
      // メッセージを取り出して idx 名を突き合わせる(TeamRepo.create の
      // SqlError 分類と同型)。
      create: (c: Contest) =>
        sql`
          INSERT INTO contests (
            id, edition, name, problem_key, problem_revision, template_vmid,
            status, instance_quota,
            scheduled_start_at, scheduled_end_at, access_closes_at, cleanup_at,
            access_closed_at, cleanup_completed_at,
            started_at, finalizing_at, finished_at, canceled_at,
            revision
          )
          VALUES (
            ${c.id}, ${c.edition}, ${c.name}, ${c.problemKey}, ${c.problemRevision}, ${c.templateVmid},
            ${c.status}, ${c.instanceQuota},
            ${Option.getOrNull(c.scheduledStartAt)}, ${Option.getOrNull(c.scheduledEndAt)},
            ${Option.getOrNull(c.accessClosesAt)}, ${Option.getOrNull(c.cleanupAt)},
            ${Option.getOrNull(c.accessClosedAt)}, ${Option.getOrNull(c.cleanupCompletedAt)},
            ${Option.getOrNull(c.startedAt)}, ${Option.getOrNull(c.finalizingAt)},
            ${Option.getOrNull(c.finishedAt)}, ${Option.getOrNull(c.canceledAt)},
            ${c.revision}
          )
        `.pipe(
          Effect.asVoid,
          Effect.catchTag(
            "SqlError",
            (cause): Effect.Effect<void, RepoError | ContestEditionConflict | OperationalContestConflict> => {
              const message = extractMessage(cause.cause)
              if (message.includes("idx_contests_edition_live")) {
                return Effect.fail(new ContestEditionConflict({ edition: c.edition }))
              }
              if (message.includes("idx_contests_single_operational")) {
                return Effect.fail(new OperationalContestConflict())
              }
              return Effect.fail(new RepoError({ cause }))
            }
          )
        ),

      // 楽観ロック: WHERE revision = expected で条件付き UPDATE し、0 行なら
      // 現在 revision を読み直して ContestRevisionConflict にする。同一 tx で
      // 判定と更新を行うため TOCTOU なし。
      saveIfRevision: (c: Contest, expectedRevision: number) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const updated = yield* sql<{ revision: number }>`
              UPDATE contests SET
                edition = ${c.edition},
                name = ${c.name},
                problem_key = ${c.problemKey},
                problem_revision = ${c.problemRevision},
                template_vmid = ${c.templateVmid},
                status = ${c.status},
                instance_quota = ${c.instanceQuota},
                scheduled_start_at = ${Option.getOrNull(c.scheduledStartAt)},
                scheduled_end_at = ${Option.getOrNull(c.scheduledEndAt)},
                access_closes_at = ${Option.getOrNull(c.accessClosesAt)},
                cleanup_at = ${Option.getOrNull(c.cleanupAt)},
                access_closed_at = ${Option.getOrNull(c.accessClosedAt)},
                cleanup_completed_at = ${Option.getOrNull(c.cleanupCompletedAt)},
                started_at = ${Option.getOrNull(c.startedAt)},
                finalizing_at = ${Option.getOrNull(c.finalizingAt)},
                finished_at = ${Option.getOrNull(c.finishedAt)},
                canceled_at = ${Option.getOrNull(c.canceledAt)},
                revision = ${c.revision}
              WHERE id = ${c.id} AND revision = ${expectedRevision}
              RETURNING revision
            `
            if (updated.length > 0) return c
            const current = yield* sql<{ revision: number }>`SELECT revision FROM contests WHERE id = ${c.id}`
            const actual = current.length > 0 ? current[0].revision : 0
            return yield* Effect.fail(new ContestRevisionConflict({ expected: expectedRevision, actual }))
          })
        ).pipe(
          Effect.catchTag("SqlError", (cause) => Effect.fail(new RepoError({ cause })))
        )
    }
  })
)
