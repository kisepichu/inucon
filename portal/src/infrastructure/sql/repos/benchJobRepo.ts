import { SqlClient } from "@effect/sql"
import { Effect, Layer, Option } from "effect"
import type { BenchJobStatus } from "../../../domain/benchJob.js"
import { BenchJob } from "../../../domain/benchJob.js"
import { CannotCancelRunning, InvalidJobTransition, TeamJobAlreadyQueued } from "../../../domain/errors.js"
import type { BenchJobId } from "../../../domain/ids.js"
import { InstanceId, TeamId } from "../../../domain/ids.js"
import { InstanceNotRunning } from "../../../application/errors.js"
import { BenchJobRepo } from "../../../application/ports.js"
import { boolToInt, decodeRow, nullableIntToBool, optionBoolToNullableInt, optionToNull, wrapSqlError } from "./support.js"

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
    passed: nullableIntToBool(row.passed)
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
      //
      // requireRunningInstance(Task 6 レビュー #D、id 照合は #H): enqueueBenchJob の
      // instanceId 起点の enqueue だけが渡す。渡された場合、この INSERT の
      // WHERE に「対象 instance が今も running であること」を
      // `AND EXISTS (SELECT 1 FROM instances WHERE ...)` として同一原子操作に
      // 追加する(instanceId パス専用の追加ガード)。
      // 【Task 6 レビュー #H】この EXISTS は id で対象行を一意に特定する
      // (`id = requireRunningInstance.instanceId`)。team_id + private_ip だけの
      // 照合では、対象 instance 自体は running でなくなっていても、スロット
      // 再利用や admin 台帳取り込みの重複 IP によって「同じ team・同じ IP の
      // 別の running 行」がたまたま存在すると誤って通ってしまう。id が
      // 対象行を一意に決める権威であり、team_id は defensive な追加条件として
      // 残す(他チームの instance id を誤って渡すような呼び出し側のバグを
      // 二重に防ぐだけで、判定自体は id で完結する)。
      //
      // 【Task 6 レビュー #I】上の instanceGuard は instanceId 経由の enqueue
      // にしか付かない。手動 IP:port 指定(直接 targetIp/targetPort を渡す)の
      // enqueue でも、targetIp がたまたま自チームの managed instance の
      // private_ip と一致していれば同じ VM を狙える(スペックはこの直接指定
      // フォームを禁止していない)。そのため削除(instanceRepo.
      // beginDeletingIfAllowed が status を deleting へ)と enqueue のレースは
      // instanceId パスだけでなく直接 IP パスでも起こりうるが、直接 IP パスは
      // instanceGuard が付かないため、削除 UPDATE が先に確定していても素通り
      // して「削除中の VM に対するジョブ」を作れてしまっていた(フォームの
      // 選び方でクロス集約不変条件が守られたり守られなかったりする不整合)。
      //
      // 対策: フォームを問わない universalInstanceGuard を追加する。
      // 「job.targetIp と private_ip が一致し、かつ team_id が一致する
      // instances 行の中に creating/deleting のものが無いこと」を常に(id
      // 指定の有無に関わらず)同一原子的 INSERT の WHERE に含める。
      //   - running な managed instance(意図した対象)は対象外(許可され続ける)。
      //   - instance 行が無い(unmanaged)targetIp も対象外(許可され続ける、
      //     手動 IP:port の主要ユースケース)。
      //   - failed/deleted な instance がその IP にあっても対象外(スコープ外
      //     — instanceId パスの by-id running チェックが別途それを見る)。
      // instanceGuard(by-id running)は instanceId パス限定のより厳しい
      // 追加条件として、universalInstanceGuard とは独立に両方 WHERE に乗る。
      //
      // instanceRepo.beginDeletingIfAllowed 側も対称に「対象 IP を
      // targetIp とする queued/running な bench_jobs が無いこと」を UPDATE の
      // WHERE に含めているため、削除 UPDATE とこの INSERT のどちらが先に
      // 確定してもレースなく相手を検出できる(SQLite が書き込みを直列化する
      // ため、後に実行された側が必ず先に確定した側の結果を見る)。
      //
      // 0 行挿入時の原因切り分け(優先順位、いずれも呼び出し元へ返す型付き
      // エラーを選ぶためだけの読み直しで、許可判定自体は上の単一原子的 INSERT
      // が行っている、createIfAllowed と同じ方針):
      //   1. team のキュー不変条件(NOT EXISTS 側)が原因なら TeamJobAlreadyQueued。
      //   2. そうでなく、universalInstanceGuard に該当する creating/deleting な
      //      managed instance が targetIp にあれば InstanceNotRunning(その
      //      instance の id を team_id+private_ip で引き直して載せる。
      //      instanceId パス・直接 IP パスの両方でここに落ちる)。
      //   3. そうでなく instanceId パス(requireRunningInstance あり)なら、
      //      by-id running チェックが原因(#H)なので requireRunningInstance の
      //      instanceId で InstanceNotRunning。
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
                      AND team_id = ${requireRunningInstance.teamId}
                      AND status = 'running'
                  )`
                : sql.literal("")
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
                AND NOT EXISTS (
                  SELECT 1 FROM instances
                  WHERE team_id = ${job.teamId} AND private_ip = ${job.targetIp}
                    AND status IN ('creating', 'deleting')
                )
                ${instanceGuard}
                RETURNING ${columns}
              `
              if (rows.length === 0) {
                const teamQueueRows = yield* sql<{ id: string }>`
                  SELECT id FROM bench_jobs
                  WHERE team_id = ${job.teamId} AND status IN ('queued', 'running')
                `
                if (teamQueueRows.length > 0) {
                  return yield* Effect.fail(new TeamJobAlreadyQueued({ teamId: job.teamId }))
                }
                const blockingInstanceRows = yield* sql<{ id: string }>`
                  SELECT id FROM instances
                  WHERE team_id = ${job.teamId} AND private_ip = ${job.targetIp}
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
                // 防御的フォールバック: 上の3条件のいずれにも該当しないのに
                // 0 行挿入になるケースは想定していない(team のキュー不変条件
                // でも universalInstanceGuard でもなく、instanceId パスでも
                // ないなら instanceGuard は空フラグメントで WHERE に影響しない
                // ため、他に挿入を阻む条件が無いはず)。万一到達した場合も
                // 誤って InstanceNotRunning と誤報しないよう、既存の
                // TeamJobAlreadyQueued 判定にフォールバックする。
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

      // finishIfRunning と対称の条件付き UPDATE 1 文 + RETURNING(TOCTOU 回避)。
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
