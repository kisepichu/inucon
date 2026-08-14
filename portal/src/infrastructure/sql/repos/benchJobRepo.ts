import { SqlClient } from "@effect/sql"
import { Effect, Layer, Option } from "effect"
import type { BenchJobPurpose, BenchJobStatus } from "../../../domain/benchJob.js"
import { BenchJob } from "../../../domain/benchJob.js"
import { CannotCancelRunning, InvalidJobTransition, TeamJobAlreadyQueued } from "../../../domain/errors.js"
import type { BenchJobId, ContestId } from "../../../domain/ids.js"
import { InstanceId, TeamId } from "../../../domain/ids.js"
import { InstanceNotRunning } from "../../../application/errors.js"
import { BenchJobRepo } from "../../../application/ports.js"
import { boolToInt, decodeRow, nullableIntToBool, optionBoolToNullableInt, optionToNull, wrapSqlError } from "./support.js"

interface BenchJobRow {
  readonly id: string
  readonly contestId: string
  readonly teamId: string
  readonly targetIp: string
  readonly targetPort: number
  readonly status: string
  readonly purpose: string
  readonly score: number | null
  readonly passed: number | null
  readonly errorMessage: string | null
  readonly enqueuedAt: number
  readonly startedAt: number | null
  readonly finishedAt: number | null
  readonly lastProgressAt: number | null
}

const BENCH_JOB_COLUMNS = `
  id, contest_id AS contestId, team_id AS teamId, target_ip AS targetIp,
  target_port AS targetPort, status, purpose,
  score, passed, error_message AS errorMessage, enqueued_at AS enqueuedAt,
  started_at AS startedAt, finished_at AS finishedAt, last_progress_at AS lastProgressAt
`

const decodeBenchJob = (row: BenchJobRow) =>
  decodeRow(BenchJob, {
    ...row,
    passed: nullableIntToBool(row.passed)
  })

export const BenchJobRepoLive: Layer.Layer<BenchJobRepo, never, SqlClient.SqlClient> = Layer.effect(
  BenchJobRepo,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const columns = sql.literal(BENCH_JOB_COLUMNS)

    const currentStatusOrDie = (id: BenchJobId) =>
      wrapSqlError(sql<{ status: string }>`SELECT status FROM bench_jobs WHERE id = ${id}`).pipe(
        Effect.flatMap((rows) =>
          rows.length === 0
            ? Effect.dieMessage(`BenchJob ${id} not found`)
            : Effect.succeed(rows[0].status as BenchJobStatus)
        )
      )

    return {
      // team のキュー不変条件は contest スコープに絞る(異なる contest への
      // 並行 enqueue は妨げない — 現状 dequeue は 1 contest しか動かないため
      // 実質的な並行は起きないが、DB 制約と application ガードは常に scope
      // 一致で判定する)。universal instance guard も同じく contest スコープ。
      insertIfAllowed: (
        job: BenchJob,
        requireRunningInstance?: { instanceId: InstanceId; teamId: TeamId }
      ) =>
        wrapSqlError(
          sql.withTransaction(
            Effect.gen(function* () {
              const instanceGuard = requireRunningInstance
                ? sql`AND EXISTS (
                    SELECT 1 FROM instances
                    WHERE id = ${requireRunningInstance.instanceId}
                      AND contest_id = ${job.contestId}
                      AND team_id = ${requireRunningInstance.teamId}
                      AND status = 'running'
                  )`
                : sql.literal("")
              const rows = yield* sql<BenchJobRow>`
                INSERT INTO bench_jobs
                  (id, contest_id, team_id, target_ip, target_port, status, purpose, score, passed, error_message,
                   enqueued_at, started_at, finished_at, last_progress_at)
                SELECT
                  ${job.id}, ${job.contestId}, ${job.teamId}, ${job.targetIp}, ${job.targetPort}, ${job.status},
                  ${job.purpose},
                  ${optionToNull(job.score)}, ${optionBoolToNullableInt(job.passed)}, ${optionToNull(job.errorMessage)},
                  ${job.enqueuedAt}, ${optionToNull(job.startedAt)}, ${optionToNull(job.finishedAt)},
                  ${optionToNull(job.lastProgressAt)}
                WHERE NOT EXISTS (
                  SELECT 1 FROM bench_jobs
                  WHERE contest_id = ${job.contestId} AND team_id = ${job.teamId}
                    AND status IN ('queued', 'running')
                )
                AND NOT EXISTS (
                  SELECT 1 FROM instances
                  WHERE contest_id = ${job.contestId} AND team_id = ${job.teamId}
                    AND private_ip = ${job.targetIp}
                    AND status IN ('creating', 'deleting')
                )
                ${instanceGuard}
                RETURNING ${columns}
              `
              if (rows.length === 0) {
                const teamQueueRows = yield* sql<{ id: string }>`
                  SELECT id FROM bench_jobs
                  WHERE contest_id = ${job.contestId} AND team_id = ${job.teamId}
                    AND status IN ('queued', 'running')
                `
                if (teamQueueRows.length > 0) {
                  return yield* Effect.fail(new TeamJobAlreadyQueued({ teamId: job.teamId }))
                }
                const blockingInstanceRows = yield* sql<{ id: string }>`
                  SELECT id FROM instances
                  WHERE contest_id = ${job.contestId} AND team_id = ${job.teamId}
                    AND private_ip = ${job.targetIp}
                    AND status IN ('creating', 'deleting')
                `
                if (blockingInstanceRows.length > 0) {
                  return yield* Effect.fail(
                    new InstanceNotRunning({ instanceId: InstanceId.make(blockingInstanceRows[0].id) })
                  )
                }
                if (requireRunningInstance) {
                  return yield* Effect.fail(
                    new InstanceNotRunning({ instanceId: requireRunningInstance.instanceId })
                  )
                }
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

      listByTeam: (contestId: ContestId, teamId: TeamId, limit: number) =>
        wrapSqlError(
          sql<BenchJobRow>`
            SELECT ${columns} FROM bench_jobs
            WHERE contest_id = ${contestId} AND team_id = ${teamId}
            ORDER BY enqueued_at DESC LIMIT ${limit}
          `
        ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, decodeBenchJob))),

      // Task 3: dequeue 対象は「候補の contest かつ candidate.purpose」に絞る。
      // running 排他も同じ contest 内で 1 本に絞ることで、旧 contest から
      // 掃除しきれなかった stale 'running' 行(runner クラッシュで
      // failIfRunning が呼ばれず failTimedOutJobs sweep 待ちの状態)が
      // 新しい contest の dequeue をブロックしないようにする。
      // 0004 の idx_contests_single_operational が preparing/running/
      // finalizing の contest を全体で 1 件に絞る前提と併せて「同時 running
      // ジョブは 1 本」を保証する。
      dequeueNextQueued: (
        candidate: { contestId: ContestId; purpose: BenchJobPurpose },
        now: number
      ) =>
        wrapSqlError(
          sql.withTransaction(
            sql<BenchJobRow>`
              UPDATE bench_jobs
              SET status = 'running', started_at = ${now}, last_progress_at = ${now}
              WHERE id = (
                SELECT id FROM bench_jobs
                WHERE status = 'queued'
                  AND contest_id = ${candidate.contestId}
                  AND purpose = ${candidate.purpose}
                  AND NOT EXISTS (
                    SELECT 1 FROM bench_jobs
                    WHERE contest_id = ${candidate.contestId} AND status = 'running'
                  )
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

      failIfRunning: (id: BenchJobId, errorMessage: string, now: number) =>
        wrapSqlError(
          sql<BenchJobRow>`
            UPDATE bench_jobs
            SET status = 'failed', error_message = ${errorMessage}, finished_at = ${now}
            WHERE id = ${id} AND status = 'running'
            RETURNING ${columns}
          `
        ).pipe(
          Effect.flatMap((rows) =>
            rows.length > 0
              ? decodeBenchJob(rows[0])
              : currentStatusOrDie(id).pipe(
                  Effect.flatMap((from) => Effect.fail(new InvalidJobTransition({ jobId: id, from, action: "fail" })))
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

      // preparing→running 遷移直後に、まだ queued の rehearsal を一括で
      // canceled にする。insertIfAllowed の NOT EXISTS(purpose 非依存)が
      // 同一チームの competition enqueue を永久ブロックする footgun 対策。
      cancelQueuedRehearsalsForContest: (contestId: ContestId) =>
        wrapSqlError(
          sql`
            UPDATE bench_jobs SET status = 'canceled'
            WHERE contest_id = ${contestId} AND status = 'queued' AND purpose = 'rehearsal'
          `
        ).pipe(Effect.asVoid),

      // Task 3: 集計対象は当該 contest かつ purpose='competition' の finished
      // のみ。rehearsal は表示しない。0 件チームも teams 列を LEFT で残す。
      scoreboard: (contestId: ContestId) =>
        wrapSqlError(
          sql<{ teamId: string; teamName: string; bestScore: number | null; latestScore: number | null; latestAt: number | null }>`
            SELECT
              t.id AS teamId,
              t.name AS teamName,
              (SELECT MAX(score) FROM bench_jobs
                 WHERE contest_id = ${contestId} AND team_id = t.id AND status = 'finished' AND purpose = 'competition') AS bestScore,
              (SELECT score FROM bench_jobs
                 WHERE contest_id = ${contestId} AND team_id = t.id AND status = 'finished' AND purpose = 'competition'
                 ORDER BY finished_at DESC, id DESC LIMIT 1) AS latestScore,
              (SELECT finished_at FROM bench_jobs
                 WHERE contest_id = ${contestId} AND team_id = t.id AND status = 'finished' AND purpose = 'competition'
                 ORDER BY finished_at DESC, id DESC LIMIT 1) AS latestAt
            FROM teams t
            WHERE t.contest_id = ${contestId}
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
