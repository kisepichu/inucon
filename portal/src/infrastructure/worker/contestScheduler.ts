import { Clock, Effect, Layer, Option, Schedule } from "effect"
import { ContestRepo, OperationInProgress, OperationRepo } from "../../application/ports.js"
import { requestFinalization } from "../../application/usecases/finalization.js"

// Task 11 §Step 4: scheduled finalization worker。単一 tick は次を行う:
//   1. list contest から scheduledEndAt <= now かつ status='running' な 1 件を拾う
//      (partial unique idx_contests_single_operational により 0 or 1 件)。
//      無ければ tick 終了。
//   2. requestFinalization を呼ぶ。usecase 内で revision-guarded
//      running→finalizing 遷移 + finish Operation の enqueue を試みる。
//        - OperationInProgress: 他 Operation がグローバル lock 中。次 tick で再試行。
//        - InvalidContestTransition (from=finalizing 等): 既に別 admin が
//          finalize 済み。次 tick で enqueue を試みる (usecase 側で status が
//          finalizing なら enqueue に進む)。
//        - RepoError / ContestNotFound: 一時故障。logError で握って次 tick。
//   3. 既に status='finalizing' な contest も同様に requestFinalization を呼ぶ:
//      「finalizing 遷移だけ通って enqueue で lock 中だったケース」の再挑戦。
//
// spec: 「revision-guarded `running -> finalizing` transition even when
// another global Operation currently owns the lock, so new competition
// enqueue stops at the deadline. It then keeps attempting to enqueue exactly
// one finish Operation after the lock is released.」
//
// 「exactly one」の保証は OperationRepo.enqueue の partial unique index
// (idx_operations_single_unfinished) が最終的な砦。scheduler restart 後の
// 二重 enqueue も、restart 前に enqueue 済みの finish Operation が
// unfinished である限り OperationInProgress を返して弾かれる。

export const DEFAULT_CONTEST_SCHEDULER_INTERVAL_MILLIS = 5_000

// テストで直接呼び出す tick。now は明示的に受ける (worker Layer は Clock で
// 供給する)。返り値は「今回 enqueue に成功した Operation 数」を数える
// (可観測性のため; 0 は「skip/待機」の意)。
export const tickContestScheduler = (
  now: number
): Effect.Effect<number, never, ContestRepo | OperationRepo> =>
  Effect.gen(function* () {
    const contests = yield* ContestRepo
    const list = yield* contests.list.pipe(
      Effect.catchAll((cause) =>
        Effect.logError(`contestScheduler: list failed: ${String(cause)}`).pipe(Effect.as([]))
      )
    )
    let enqueued = 0
    for (const c of list) {
      const endAt = Option.getOrNull(c.scheduledEndAt)
      if (endAt === null) continue
      if (endAt > now) continue
      if (c.status !== "running" && c.status !== "finalizing") continue

      // requestFinalization は running/finalizing どちらも受け付ける
      // (running なら revision-guarded 遷移 + enqueue、finalizing なら enqueue のみ)。
      const result = yield* Effect.either(
        requestFinalization({ contestId: c.id, actor: { kind: "scheduler" } })
      )
      if (result._tag === "Right") {
        enqueued += 1
      } else if (result.left instanceof OperationInProgress) {
        // 他 Operation が lock 中: 想定内。次 tick で再試行する。
        yield* Effect.logDebug(
          `contestScheduler: finish enqueue deferred (OperationInProgress) for contestId=${c.id}`
        )
      } else if (result.left._tag === "InvalidContestTransition") {
        // 既に他 admin が finalize 済み or 状態が finished/canceled 等。
        yield* Effect.logDebug(
          `contestScheduler: finish enqueue skipped (transition) for contestId=${c.id} from=${result.left.from}`
        )
      } else if (result.left._tag === "ContestNotFound") {
        // list 直後に消えるのは想定外だが、他 admin の cascade cancel + delete
        // が絡む場合の防御。次 tick で自然に list から抜ける。
        yield* Effect.logWarning(
          `contestScheduler: contest disappeared mid-tick: contestId=${c.id}`
        )
      } else {
        // RepoError: 一時故障。次 tick で自然に再試行される。
        yield* Effect.logError(
          `contestScheduler: finalize repo error for contestId=${c.id}: ${String(result.left)}`
        )
      }
    }
    return enqueued
  })

// (removed identity helper; catchAll returns [] as ReadonlyArray<Contest> via Effect.as)

// バックグラウンドワーカー Layer。TimeoutSweeperLive と同型の scoped-forked
// ループ。tick 間隔は Env で調整できないが、5 秒は十分粗く portal の
// scheduler が持ち回りできる想定値(scheduledEndAt の到達精度は「5 秒以内」)。
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
