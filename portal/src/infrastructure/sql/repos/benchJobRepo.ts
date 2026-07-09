import { SqlClient } from "@effect/sql"
import { Effect, Layer, Option } from "effect"
import type { BenchJobStatus } from "../../../domain/benchJob.js"
import { BenchJob } from "../../../domain/benchJob.js"
import { CannotCancelRunning, InvalidJobTransition, TeamJobAlreadyQueued } from "../../../domain/errors.js"
import type { BenchJobId } from "../../../domain/ids.js"
import { TeamId } from "../../../domain/ids.js"
import { BenchJobRepo } from "../../../application/ports.js"
import { boolToInt, decodeRow, optionBoolToNullableInt, optionToNull, wrapSqlError } from "./support.js"

interface BenchJobRow {
  readonly id: string
  readonly teamId: string
  readonly targetIp: string
  readonly targetPort: number
  readonly status: string
  readonly score: number | null
  readonly passed: number | null
  readonly errorMessage: string | null
  readonly enqueuedAt: number
  readonly startedAt: number | null
  readonly finishedAt: number | null
  readonly lastProgressAt: number | null
}

// SELECT / RETURNING で共通して使う列リスト。snake_case → camelCase の対応は
// ここに一元化された AS 句で明示する(transformResultNames は使わない)。
const BENCH_JOB_COLUMNS = `
  id, team_id AS teamId, target_ip AS targetIp, target_port AS targetPort, status,
  score, passed, error_message AS errorMessage, enqueued_at AS enqueuedAt,
  started_at AS startedAt, finished_at AS finishedAt, last_progress_at AS lastProgressAt
`

const decodeBenchJob = (row: BenchJobRow) =>
  decodeRow(BenchJob, {
    ...row,
    passed: row.passed === null ? null : row.passed === 1
  })

export const BenchJobRepoLive: Layer.Layer<BenchJobRepo, never, SqlClient.SqlClient> = Layer.effect(
  BenchJobRepo,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const columns = sql.literal(BENCH_JOB_COLUMNS)

    // 0 行更新時のエラー構築用: ジョブの現在 status を読み直す。
    // ジョブ自体が存在しない場合は defect(die)にする(ports.ts の契約)。
    const currentStatusOrDie = (id: BenchJobId) =>
      wrapSqlError(sql<{ status: string }>`SELECT status FROM bench_jobs WHERE id = ${id}`).pipe(
        Effect.flatMap((rows) =>
          rows.length === 0
            ? Effect.dieMessage(`BenchJob ${id} not found`)
            : Effect.succeed(rows[0].status as BenchJobStatus)
        )
      )

    return {
      // 存在チェックと INSERT を単一の条件付き INSERT ... SELECT ... WHERE NOT
      // EXISTS ... RETURNING 文でアトミックに行う(TOCTOU 回避)。並行 fiber が
      // それぞれ別文で COUNT→INSERT すると両方が count=0 を読める余地がある
      // が、1 文の INSERT...SELECT なら DB のロックにより直列化される。
      // 0 行挿入(= 既に queued/running あり)なら TeamJobAlreadyQueued。
      // bench_job_logs の空行 INSERT は同一トランザクション内の別文のまま。
      insertIfAllowed: (job: BenchJob) =>
        wrapSqlError(
          sql.withTransaction(
            Effect.gen(function* () {
              const rows = yield* sql<BenchJobRow>`
                INSERT INTO bench_jobs
                  (id, team_id, target_ip, target_port, status, score, passed, error_message,
                   enqueued_at, started_at, finished_at, last_progress_at)
                SELECT
                  ${job.id}, ${job.teamId}, ${job.targetIp}, ${job.targetPort}, ${job.status},
                  ${optionToNull(job.score)}, ${optionBoolToNullableInt(job.passed)}, ${optionToNull(job.errorMessage)},
                  ${job.enqueuedAt}, ${optionToNull(job.startedAt)}, ${optionToNull(job.finishedAt)},
                  ${optionToNull(job.lastProgressAt)}
                WHERE NOT EXISTS (
                  SELECT 1 FROM bench_jobs WHERE team_id = ${job.teamId} AND status IN ('queued', 'running')
                )
                RETURNING ${columns}
              `
              if (rows.length === 0) {
                return yield* Effect.fail(new TeamJobAlreadyQueued({ teamId: job.teamId }))
              }
              yield* sql`INSERT INTO bench_job_logs (job_id, log) VALUES (${job.id}, '')`
              return yield* decodeBenchJob(rows[0])
            })
          )
        ),

      findById: (id: BenchJobId) =>
        wrapSqlError(sql<BenchJobRow>`SELECT ${columns} FROM bench_jobs WHERE id = ${id}`).pipe(
          Effect.flatMap((rows) =>
            rows.length === 0
              ? Effect.succeed(Option.none<BenchJob>())
              : decodeBenchJob(rows[0]).pipe(Effect.map(Option.some))
          )
        ),

      listByTeam: (teamId: TeamId, limit: number) =>
        wrapSqlError(
          sql<BenchJobRow>`
            SELECT ${columns} FROM bench_jobs WHERE team_id = ${teamId}
            ORDER BY enqueued_at DESC LIMIT ${limit}
          `
        ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, decodeBenchJob))),

      // 全体で running が 1 件でもあれば対象外にする WHERE 句込みの単一
      // UPDATE 文でアトミックに先頭 queued を running 化する。
      dequeueNextQueued: (now: number) =>
        wrapSqlError(
          sql.withTransaction(
            sql<BenchJobRow>`
              UPDATE bench_jobs
              SET status = 'running', started_at = ${now}, last_progress_at = ${now}
              WHERE id = (
                SELECT id FROM bench_jobs
                WHERE status = 'queued'
                  AND NOT EXISTS (SELECT 1 FROM bench_jobs WHERE status = 'running')
                ORDER BY enqueued_at, id
                LIMIT 1
              )
              RETURNING ${columns}
            `.pipe(
              Effect.flatMap((rows) =>
                rows.length === 0
                  ? Effect.succeed(Option.none<BenchJob>())
                  : decodeBenchJob(rows[0]).pipe(Effect.map(Option.some))
              )
            )
          )
        ),

      appendLog: (id: BenchJobId, chunk: string) =>
        wrapSqlError(sql`UPDATE bench_job_logs SET log = log || ${chunk} WHERE job_id = ${id}`).pipe(Effect.asVoid),

      getLog: (id: BenchJobId) =>
        wrapSqlError(sql<{ log: string }>`SELECT log FROM bench_job_logs WHERE job_id = ${id}`).pipe(
          Effect.map((rows) => (rows.length === 0 ? "" : rows[0].log))
        ),

      // 判定(status='running' AND last_progress_at < cutoff)と更新を単一の
      // UPDATE ... RETURNING 文で行う。reportFinish 側は status='running' の
      // 行しか更新しないため、finished 済みの行はこの WHERE 句にそもそも
      // マッチせず上書きされない。
      failTimedOutJobs: (cutoff: number, now: number) =>
        wrapSqlError(
          sql<{ id: string }>`
            UPDATE bench_jobs
            SET status = 'failed', error_message = 'timeout', finished_at = ${now}
            WHERE status = 'running' AND last_progress_at < ${cutoff}
            RETURNING id
          `
        ).pipe(Effect.map((rows) => rows.length)),

      recordProgressIfRunning: (id: BenchJobId, now: number) =>
        wrapSqlError(
          sql<BenchJobRow>`
            UPDATE bench_jobs SET last_progress_at = ${now}
            WHERE id = ${id} AND status = 'running'
            RETURNING ${columns}
          `
        ).pipe(
          Effect.flatMap((rows) =>
            rows.length > 0
              ? decodeBenchJob(rows[0])
              : currentStatusOrDie(id).pipe(
                  Effect.flatMap((from) =>
                    Effect.fail(new InvalidJobTransition({ jobId: id, from, action: "recordProgress" }))
                  )
                )
          )
        ),

      finishIfRunning: (id: BenchJobId, result: { score: number; passed: boolean }, now: number) =>
        wrapSqlError(
          sql<BenchJobRow>`
            UPDATE bench_jobs
            SET status = 'finished', score = ${result.score}, passed = ${boolToInt(result.passed)}, finished_at = ${now}
            WHERE id = ${id} AND status = 'running'
            RETURNING ${columns}
          `
        ).pipe(
          Effect.flatMap((rows) =>
            rows.length > 0
              ? decodeBenchJob(rows[0])
              : currentStatusOrDie(id).pipe(
                  Effect.flatMap((from) => Effect.fail(new InvalidJobTransition({ jobId: id, from, action: "finish" })))
                )
          )
        ),

      cancelIfQueued: (id: BenchJobId) =>
        wrapSqlError(
          sql<BenchJobRow>`
            UPDATE bench_jobs SET status = 'canceled'
            WHERE id = ${id} AND status = 'queued'
            RETURNING ${columns}
          `
        ).pipe(
          Effect.flatMap((rows) =>
            rows.length > 0
              ? decodeBenchJob(rows[0])
              : currentStatusOrDie(id).pipe(
                  Effect.flatMap((from): Effect.Effect<never, CannotCancelRunning | InvalidJobTransition> =>
                    from === "running"
                      ? Effect.fail(new CannotCancelRunning({ jobId: id }))
                      : Effect.fail(new InvalidJobTransition({ jobId: id, from, action: "cancel" }))
                  )
                )
          )
        ),

      // best = そのチームの finished ジョブ中の MAX(score)。
      // latest = finished_at が最大の finished 行の score(同値タイは id 降順で
      // 決定的にする)。どちらも finished 以外(canceled/failed/queued/running)
      // は対象外。チームが 1 件も finished を持たなくても teams の行自体は
      // 必ず返す(LEFT 相当のスカラサブクエリのため NULL になるだけ)。
      scoreboard: wrapSqlError(
        sql<{ teamId: string; teamName: string; bestScore: number | null; latestScore: number | null; latestAt: number | null }>`
          SELECT
            t.id AS teamId,
            t.name AS teamName,
            (SELECT MAX(score) FROM bench_jobs WHERE team_id = t.id AND status = 'finished') AS bestScore,
            (SELECT score FROM bench_jobs WHERE team_id = t.id AND status = 'finished'
               ORDER BY finished_at DESC, id DESC LIMIT 1) AS latestScore,
            (SELECT finished_at FROM bench_jobs WHERE team_id = t.id AND status = 'finished'
               ORDER BY finished_at DESC, id DESC LIMIT 1) AS latestAt
          FROM teams t
          ORDER BY t.team_number
        `
      ).pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            teamId: TeamId.make(row.teamId),
            teamName: row.teamName,
            bestScore: row.bestScore,
            latestScore: row.latestScore,
            latestAt: row.latestAt
          }))
        )
      )
    }
  })
)
