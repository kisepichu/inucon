import { Clock, Effect, Layer, Option, Schedule } from "effect"
import { Contest } from "../../domain/contest.js"
// keep tick signature clear
import { AmbiguousReconciliation, ContestNotFound, NothingToReconcile } from "../../application/errors.js"
import {
  CloudflarePort,
  ContestRepo,
  InstanceRepo,
  OperationInProgress,
  OperationRepo,
  ProxmoxPort,
  ResourceBindingRepo,
  TeamRepo
} from "../../application/ports.js"
import { closeContestAccess, scheduleContestCleanup } from "../../application/usecases/cleanup.js"
import { requestFinalization } from "../../application/usecases/finalization.js"

// Task 11/12: scheduled finalization + access close + cleanup sweep worker。
// 単一 tick は Contest 一覧に対して次の 3 判定を行う (順序は評価優先度):
//
//   1. scheduledEndAt <= now かつ running/finalizing → requestFinalization
//      (running→finalizing 遷移 + finish Operation の enqueue)
//   2. accessClosesAt <= now かつ accessClosedAt IS NULL → closeContestAccess
//      (Task 12: revoke_access Operation)。global 単一 unfinished lock を
//      finish が握っている間は OperationInProgress で skip し、次 tick で再試行。
//      「同一 (contest, kind='revoke_access') の queued/running/blocked/failed
//      Operation が既に居る」場合も skip (二重 enqueue 抑止)。
//   3. cleanupAt <= now かつ cleanupCompletedAt IS NULL → scheduleContestCleanup
//      (Task 12: cleanup Operation)。同じく at-most-once ガード。
//
// due predicate 自体が「succeeded 後に再 enqueue しない」根源的な砦 (spec §Step 3/4)、
// hasUnfinishedByContestAndKind は「まだ実行中 / operator 対応待ち / 失敗を放置」
// のケースを重ねてカバーする defensive guard。

export const DEFAULT_CONTEST_SCHEDULER_INTERVAL_MILLIS = 5_000

// テストで直接呼び出す tick。now は明示的に受ける (worker Layer は Clock で
// 供給する)。返り値は「今回 enqueue に成功した Operation 数」。
export const tickContestScheduler = (
  now: number
): Effect.Effect<
  number,
  never,
  | ContestRepo
  | OperationRepo
  | InstanceRepo
  | ResourceBindingRepo
  | TeamRepo
  | ProxmoxPort
  | CloudflarePort
> =>
  Effect.gen(function* () {
    const contests = yield* ContestRepo
    const list = yield* contests.list.pipe(
      Effect.catchAll((cause) =>
        Effect.logError(`contestScheduler: list failed: ${String(cause)}`).pipe(Effect.as([]))
      )
    )
    let enqueued = 0
    for (const c of list) {
      enqueued += yield* tickFinalize(c, now)
      enqueued += yield* tickRevokeAccess(c, now)
      enqueued += yield* tickCleanup(c, now)
    }
    return enqueued
  })

// running/finalizing Contest の scheduledEndAt 到達を検出して finish Operation を
// 積む (Task 11 で既に存在した経路をそのまま関数抽出)。
const tickFinalize = (
  c: Contest,
  now: number
): Effect.Effect<number, never, ContestRepo | OperationRepo> =>
  Effect.gen(function* () {
    const endAt = Option.getOrNull(c.scheduledEndAt)
    if (endAt === null) return 0
    if (endAt > now) return 0
    if (c.status !== "running" && c.status !== "finalizing") return 0

    const result = yield* Effect.either(
      requestFinalization({ contestId: c.id, actor: { kind: "scheduler" } })
    )
    if (result._tag === "Right") return 1
    if (result.left instanceof OperationInProgress) {
      yield* Effect.logDebug(
        `contestScheduler: finish enqueue deferred (OperationInProgress) for contestId=${c.id}`
      )
      return 0
    }
    if (result.left._tag === "InvalidContestTransition") {
      yield* Effect.logDebug(
        `contestScheduler: finish enqueue skipped (transition) for contestId=${c.id} from=${result.left.from}`
      )
      return 0
    }
    if (result.left._tag === "ContestNotFound") {
      yield* Effect.logWarning(
        `contestScheduler: contest disappeared mid-tick: contestId=${c.id}`
      )
      return 0
    }
    // RepoError: 一時故障。次 tick で自然に再試行される。
    yield* Effect.logError(
      `contestScheduler: finalize repo error for contestId=${c.id}: ${String(result.left)}`
    )
    return 0
  })

// accessClosesAt 到達で revoke_access Operation を積む。既に same-kind
// unfinished (queued/running/blocked/failed) があれば skip する。
const tickRevokeAccess = (
  c: Contest,
  now: number
): Effect.Effect<number, never, ContestRepo | OperationRepo> =>
  Effect.gen(function* () {
    const dueAt = Option.getOrNull(c.accessClosesAt)
    if (dueAt === null) return 0
    if (dueAt > now) return 0
    if (Option.isSome(c.accessClosedAt)) return 0

    const ops = yield* OperationRepo
    // review round 2: DB blip でも guard を bypass しないよう、失敗時は
    // 「未完了あり」扱いにして次 tick に委ねる (二重 enqueue より 1 tick 遅延の方が安全)。
    const already = yield* ops.hasUnfinishedByContestAndKind(c.id, "revoke_access").pipe(
      Effect.catchAll(() => Effect.succeed(true))
    )
    if (already) return 0

    const result = yield* Effect.either(
      closeContestAccess({ contestId: c.id, actor: { kind: "scheduler" } })
    )
    if (result._tag === "Right") return 1
    if (result.left instanceof OperationInProgress) {
      yield* Effect.logDebug(
        `contestScheduler: revoke_access deferred (global lock) for contestId=${c.id}`
      )
      return 0
    }
    if (result.left instanceof ContestNotFound) {
      yield* Effect.logWarning(
        `contestScheduler: revoke_access contest disappeared: contestId=${c.id}`
      )
      return 0
    }
    yield* Effect.logError(
      `contestScheduler: revoke_access repo error for contestId=${c.id}: ${String(result.left)}`
    )
    return 0
  })

// cleanupAt 到達で cleanup Operation を積む。plan 再構築 + at-most-once ガード。
const tickCleanup = (
  c: Contest,
  now: number
): Effect.Effect<
  number,
  never,
  | ContestRepo
  | OperationRepo
  | InstanceRepo
  | ResourceBindingRepo
  | TeamRepo
  | ProxmoxPort
  | CloudflarePort
> =>
  Effect.gen(function* () {
    const dueAt = Option.getOrNull(c.cleanupAt)
    if (dueAt === null) return 0
    if (dueAt > now) return 0
    if (Option.isSome(c.cleanupCompletedAt)) return 0
    // review round 2 #1: revoke_access が先に完了していない状態で cleanup を
    // 積むと、access apps は cleanup 経由で消えても Contest.accessClosedAt は
    // null のまま (revoke_access handler だけが刻む) 永続的な不整合になる。
    // revoke_access → cleanup の順序を spec §Step 4 通り強制する。
    if (Option.isNone(c.accessClosedAt)) return 0

    const ops = yield* OperationRepo
    // review round 2: DB 失敗時は「未完了あり」扱いで skip (revoke_access と同じ理由)。
    const already = yield* ops.hasUnfinishedByContestAndKind(c.id, "cleanup").pipe(
      Effect.catchAll(() => Effect.succeed(true))
    )
    if (already) return 0

    const result = yield* Effect.either(scheduleContestCleanup({ contestId: c.id }))
    if (result._tag === "Right") return 1
    if (result.left instanceof OperationInProgress) {
      yield* Effect.logDebug(
        `contestScheduler: cleanup deferred (global lock) for contestId=${c.id}`
      )
      return 0
    }
    if (result.left instanceof NothingToReconcile) {
      // review round 3 #1: 対象 hostname が無い = 実質 cleanup 完了。ここで
      // cleanupCompletedAt を直接刻まないと、次 tick 以降も同じ inventory 呼び出しを
      // 5 秒ごとに永続的に繰り返し (Proxmox/Cloudflare API を無駄に叩き続ける)、
      // かつ audit trail 上 cleanupCompletedAt は永遠に null になる。saveIfRevision
      // で楽観ロックしつつ stamp する (Operation は 0-step で回さない)。
      const contests = yield* ContestRepo
      const now = yield* Clock.currentTimeMillis
      yield* contests
        .saveIfRevision(
          new Contest({
            ...c,
            cleanupCompletedAt: Option.some(now),
            revision: c.revision + 1
          }),
          c.revision
        )
        .pipe(
          Effect.catchAll((cause) =>
            Effect.logWarning(
              `contestScheduler: cleanup stamp failed for contestId=${c.id}: ${String(cause)}`
            )
          )
        )
      return 0
    }
    if (result.left instanceof AmbiguousReconciliation) {
      yield* Effect.logWarning(
        `contestScheduler: cleanup ambiguous for contestId=${c.id}: ${result.left.hostnames.join(",")}`
      )
      return 0
    }
    if (result.left instanceof ContestNotFound) {
      yield* Effect.logWarning(
        `contestScheduler: cleanup contest disappeared: contestId=${c.id}`
      )
      return 0
    }
    yield* Effect.logError(
      `contestScheduler: cleanup provider/repo error for contestId=${c.id}: ${String(result.left)}`
    )
    return 0
  })

// バックグラウンドワーカー Layer。TimeoutSweeperLive と同型の scoped-forked
// ループ。tick 間隔は Env で調整できないが、5 秒は十分粗く portal の
// scheduler が持ち回りできる想定値 (scheduledEndAt の到達精度は「5 秒以内」)。
export const ContestSchedulerLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const tick = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      yield* tickContestScheduler(now)
    })
    yield* tick.pipe(
      Effect.catchAllCause(Effect.logError),
      Effect.repeat(Schedule.spaced(`${DEFAULT_CONTEST_SCHEDULER_INTERVAL_MILLIS} millis`)),
      Effect.forkScoped
    )
  })
)

// keep reference to avoid dead-code trimming warnings in some tsconfigs

