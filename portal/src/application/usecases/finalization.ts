import { Clock, Effect, Either, Option } from "effect"
import { beginFinalization, finishContest } from "../../domain/contest.js"
import type { Contest } from "../../domain/contest.js"
import { InvalidContestTransition } from "../../domain/errors.js"
import type { ArtifactId, ContestId, UserId } from "../../domain/ids.js"
import type { NewOperation, Operation, OperationStep } from "../../domain/operation.js"
import type { Artifact } from "../../domain/artifact.js"
import {
  ArtifactRepo,
  BackupPort,
  BenchJobRepo,
  ContestRepo,
  OperationExecutionError,
  OperationHandler,
  OperationInProgress,
  OperationRepo,
  RepoError,
  UuidGen
} from "../ports.js"
import {
  ArtifactChecksumMismatch,
  ArtifactNotFound,
  ContestNotFound,
  InvalidArchiveState
} from "../errors.js"
import type { StepOutcome } from "./operations.js"
import {
  persistDbSnapshot,
  persistScoreboardCsv,
  persistScoreboardJson,
  readScoreboardRows
} from "./archives.js"

// Task 11 §Step 4/5: finalize/backup Operation を組み立てる application 層。
//
// - requestFinalization(contestId, expectedRevision, actor):
//     manual 「immediate finish」ボタン + scheduler 双方から呼ばれる enqueue。
//     まず running→finalizing の revision-guarded 遷移(saveIfRevision)を
//     試みる。既に finalizing のときは遷移スキップ。次に finish Operation を
//     6-step で enqueue する(OperationRepo.enqueue の global unfinished lock
//     が二重 enqueue を弾く)。
//
// - requestLegacyArchive(contestId, actor):
//     legacy finished Contest を対象に「archive artifact だけ」を再生成する
//     backup Operation を enqueue する。3 step: write_scoreboard_json /
//     write_scoreboard_csv / write_db_snapshot。contest status/jobs/scores は
//     一切変えない(spec: 「idempotently generate only its missing archive
//     artifacts without changing status, jobs, or scores」)。
//
// - makeFinishContestHandler / makeBackupContestHandler:
//     OperationWorker が呼ぶ step 実行本体。stepKey で分岐する 1 ハンドラで
//     Operation kind 全体をカバーする(prepare / start と同じパターン)。

export const FINISH_STEP_KEYS = {
  cancelQueued: "cancel_queued",
  waitRunning: "wait_running",
  writeScoreboardJson: "write_scoreboard_json",
  writeScoreboardCsv: "write_scoreboard_csv",
  writeDbSnapshot: "write_db_snapshot",
  finishContest: "finish_contest"
} as const

export const BACKUP_STEP_KEYS = {
  writeScoreboardJson: "write_scoreboard_json",
  writeScoreboardCsv: "write_scoreboard_csv",
  writeDbSnapshot: "write_db_snapshot"
} as const

// finish Operation の再試行間隔(wait_running が retry を返すときのバックオフ)。
// 既存 timeoutSweeper が 10 分無進捗で running を failed に落とすため、この値は
// 「timeoutSweeper より早く再確認する」目的で選ぶ。
export const FINISH_WAIT_RUNNING_RETRY_MILLIS = 2_000

// step input(inputSummary は TEXT なので JSON.stringify で運ぶ)
interface FinishStepInput {
  readonly contestId: ContestId
}

const parseFinishStepInput = (raw: string): FinishStepInput | null => {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== "object" || parsed === null) return null
    const cid = (parsed as Record<string, unknown>).contestId
    if (typeof cid !== "string") return null
    return { contestId: cid as ContestId }
  } catch {
    return null
  }
}

// --- enqueue (application 経由の API 入口) --------------------------------

export type RequestFinalizationError =
  | RepoError
  | ContestNotFound
  | InvalidContestTransition
  | OperationInProgress

// scheduler と handler の HTTP 経路の両方から呼ばれる。
//
// spec: 「revision-guarded `running -> finalizing` transition even when another
// global Operation currently owns the lock」— 遷移は unfinished Operation の
// 有無に関係なく行い、その後 enqueue を試みる(競合中は OperationInProgress
// が返るので scheduler は次 tick で再挑戦する)。
export const requestFinalization = (args: {
  readonly contestId: ContestId
  readonly actor: Operation["actor"]
}): Effect.Effect<Operation, RequestFinalizationError, ContestRepo | OperationRepo> =>
  Effect.gen(function* () {
    const contests = yield* ContestRepo
    const found = yield* contests.findById(args.contestId)
    if (Option.isNone(found)) {
      return yield* Effect.fail(new ContestNotFound())
    }
    const contest = found.value

    // running → finalizing。既に finalizing なら skip(scheduler 経路で
    // 途中 restart した場合の再入補償)。それ以外の状態は
    // InvalidContestTransition(呼び出し元は 409 / scheduler は無視)。
    let target: Contest = contest
    if (contest.status === "running") {
      const now = yield* Clock.currentTimeMillis
      const transitioned = beginFinalization(contest, now)
      if (transitioned._tag === "Left") {
        return yield* Effect.fail(transitioned.left)
      }
      // saveIfRevision の revision drift は「別 admin が同時に転移した」ケース。
      // その場合はもう finalizing (or finished) のはずなので、再読み込みして
      // finalizing だけを続行対象にする。
      const saved = yield* contests.saveIfRevision(transitioned.right, contest.revision).pipe(
        Effect.catchTag("ContestRevisionConflict", () =>
          contests.findById(args.contestId).pipe(
            Effect.flatMap((again) =>
              Option.isSome(again) ? Effect.succeed(again.value) : Effect.fail(new ContestNotFound())
            )
          )
        )
      )
      target = saved
    }
    if (target.status !== "finalizing") {
      // scheduler が到達する典型ケース: 既に finished / canceled / preparing / draft。
      // その場合は enqueue しない(呼び出し側で判定できるように transition エラー)。
      return yield* Effect.fail(
        new InvalidContestTransition({ from: target.status, to: "finalizing" })
      )
    }

    const operations = yield* OperationRepo
    const input: NewOperation = {
      contestId: target.id,
      kind: "finish",
      actor: args.actor,
      planDigest: `finish:c${target.id}:r${target.revision}`,
      contestRevision: target.revision,
      steps: [
        { stepKey: FINISH_STEP_KEYS.cancelQueued, ordinal: 0, inputSummary: JSON.stringify({ contestId: target.id }), continueOnError: false },
        { stepKey: FINISH_STEP_KEYS.waitRunning, ordinal: 1, inputSummary: JSON.stringify({ contestId: target.id }), continueOnError: false },
        { stepKey: FINISH_STEP_KEYS.writeScoreboardJson, ordinal: 2, inputSummary: JSON.stringify({ contestId: target.id }), continueOnError: false },
        { stepKey: FINISH_STEP_KEYS.writeScoreboardCsv, ordinal: 3, inputSummary: JSON.stringify({ contestId: target.id }), continueOnError: false },
        { stepKey: FINISH_STEP_KEYS.writeDbSnapshot, ordinal: 4, inputSummary: JSON.stringify({ contestId: target.id }), continueOnError: false },
        { stepKey: FINISH_STEP_KEYS.finishContest, ordinal: 5, inputSummary: JSON.stringify({ contestId: target.id }), continueOnError: false }
      ]
    }
    return yield* operations.enqueue(input)
  })

export type RequestLegacyArchiveError =
  | RepoError
  | ContestNotFound
  | InvalidArchiveState
  | OperationInProgress

// legacy contest の archive-only 再生成。finished Contest 限定。3 step のみ。
export const requestLegacyArchive = (args: {
  readonly contestId: ContestId
  readonly actorUserId: UserId
}): Effect.Effect<Operation, RequestLegacyArchiveError, ContestRepo | OperationRepo> =>
  Effect.gen(function* () {
    const contests = yield* ContestRepo
    const found = yield* contests.findById(args.contestId)
    if (Option.isNone(found)) {
      return yield* Effect.fail(new ContestNotFound())
    }
    const contest = found.value
    if (contest.status !== "finished") {
      return yield* Effect.fail(new InvalidArchiveState({ status: contest.status }))
    }
    const operations = yield* OperationRepo
    const input: NewOperation = {
      contestId: contest.id,
      kind: "backup",
      actor: { kind: "admin", userId: args.actorUserId },
      planDigest: `backup:c${contest.id}:r${contest.revision}`,
      contestRevision: contest.revision,
      steps: [
        { stepKey: BACKUP_STEP_KEYS.writeScoreboardJson, ordinal: 0, inputSummary: JSON.stringify({ contestId: contest.id }), continueOnError: false },
        { stepKey: BACKUP_STEP_KEYS.writeScoreboardCsv, ordinal: 1, inputSummary: JSON.stringify({ contestId: contest.id }), continueOnError: false },
        { stepKey: BACKUP_STEP_KEYS.writeDbSnapshot, ordinal: 2, inputSummary: JSON.stringify({ contestId: contest.id }), continueOnError: false }
      ]
    }
    return yield* operations.enqueue(input)
  })

// --- verifyArtifactChecksum(admin) --------------------------------------

// admin が off-host に写した snapshot の SHA-256 を再入力して verify する。
// mismatch は 409。成功は artifact 行の off_host_status='verified' + verified_at。
export const verifyArtifactChecksum = (args: {
  readonly artifactId: ArtifactId
  readonly expectedSha256: string
  readonly now: number
}): Effect.Effect<Artifact, RepoError | ArtifactNotFound | ArtifactChecksumMismatch, ArtifactRepo> =>
  Effect.gen(function* () {
    const repo = yield* ArtifactRepo
    const found = yield* repo.findById(args.artifactId)
    if (Option.isNone(found)) {
      return yield* Effect.fail(new ArtifactNotFound())
    }
    const artifact = found.value
    if (artifact.sha256 !== args.expectedSha256) {
      return yield* Effect.fail(
        new ArtifactChecksumMismatch({ expected: args.expectedSha256, actual: artifact.sha256 })
      )
    }
    yield* repo.markVerified(artifact.id, args.now)
    // 反映後の値を返す(offHostStatus='verified', verifiedAt=Some(now))。
    // markVerified 自体は void なので、cheap に再取得して返す。
    const refreshed = yield* repo.findById(artifact.id)
    if (Option.isNone(refreshed)) {
      // markVerified 直後に消えるのは想定外(delete API 未実装)。die で顕在化。
      return yield* Effect.dieMessage(`verifyArtifactChecksum: artifact ${artifact.id} disappeared after markVerified`)
    }
    return refreshed.value
  })

// --- Step handler(finish / backup 共用) --------------------------------

// finish Operation の finish_contest step: 楽観ロックで finalizing → finished
// + team_invites を削除する。ContestRepo.saveIfRevisionAndPurgeInvites を
// 使うことで「行更新と DELETE の atomicity」を担保する。
const runFinishContest = (
  contestId: ContestId,
  now: number
): Effect.Effect<StepOutcome, OperationExecutionError, ContestRepo> =>
  Effect.gen(function* () {
    const contests = yield* ContestRepo
    const found = yield* contests.findById(contestId)
    if (Option.isNone(found)) {
      return { status: "blocked", summary: `contest ${contestId} not found` } satisfies StepOutcome
    }
    const contest = found.value
    if (contest.status === "finished") {
      // 既に finished(retry 経路で二重実行された)= idempotent 成功扱い。
      return { status: "succeeded", summary: "contest already finished" } satisfies StepOutcome
    }
    if (contest.status !== "finalizing") {
      return {
        status: "blocked",
        summary: `contest status is ${contest.status}, expected finalizing`
      } satisfies StepOutcome
    }
    const finished = finishContest(contest, now)
    if (finished._tag === "Left") {
      return {
        status: "blocked",
        summary: `unexpected transition failure from ${contest.status} to finished`
      } satisfies StepOutcome
    }
    const saveResult = yield* Effect.either(
      contests.saveIfRevisionAndPurgeInvites(finished.right, contest.revision)
    )
    if (saveResult._tag === "Left") {
      if (saveResult.left._tag !== "ContestRevisionConflict") {
        return yield* Effect.fail(new OperationExecutionError({ cause: saveResult.left }))
      }
      return {
        status: "blocked",
        summary: `saveIfRevision: revision conflict (expected ${saveResult.left.expected}, actual ${saveResult.left.actual})`
      } satisfies StepOutcome
    }
    return { status: "succeeded", summary: `contest ${contestId} finished` } satisfies StepOutcome
  }).pipe(Effect.catchAll((cause) => Effect.fail(new OperationExecutionError({ cause }))))

// scoreboard の archive 3 種を共通に実行する。既に upsert 済みで sha256 が
// 一致するなら skip(archive-only 再実行の idempotency)。
const runArchiveStep = (args: {
  readonly contestId: ContestId
  readonly kind: "scoreboard" | "scoreboard_csv" | "snapshot"
  readonly now: number
}): Effect.Effect<
  StepOutcome,
  OperationExecutionError,
  ArtifactRepo | BackupPort | BenchJobRepo | ContestRepo | UuidGen
> =>
  Effect.gen(function* () {
    const contests = yield* ContestRepo
    const found = yield* contests.findById(args.contestId)
    if (Option.isNone(found)) {
      return { status: "blocked", summary: `contest ${args.contestId} not found` } satisfies StepOutcome
    }
    const contest = found.value
    // scoreboard 系は BenchJobRepo.scoreboard を経由(purpose='competition' filter)。
    if (args.kind === "scoreboard" || args.kind === "scoreboard_csv") {
      const rows = yield* readScoreboardRows(args.contestId)
      const artifact =
        args.kind === "scoreboard"
          ? yield* persistScoreboardJson({
              contestId: args.contestId,
              edition: contest.edition,
              now: args.now,
              rows
            })
          : yield* persistScoreboardCsv({
              contestId: args.contestId,
              edition: contest.edition,
              now: args.now,
              rows
            })
      return {
        status: "succeeded",
        summary: `wrote ${args.kind} bytes=${artifact.sizeBytes} sha256=${artifact.sha256}`
      } satisfies StepOutcome
    }
    // snapshot は BackupPort.createSnapshot 経由(portal DB の online backup)。
    const artifact = yield* persistDbSnapshot({
      contestId: args.contestId,
      edition: contest.edition,
      now: args.now
    })
    return {
      status: "succeeded",
      summary: `wrote snapshot bytes=${artifact.sizeBytes} sha256=${artifact.sha256}`
    } satisfies StepOutcome
  }).pipe(Effect.catchAll((cause) => Effect.fail(new OperationExecutionError({ cause }))))

// cancel_queued step: BenchJobRepo.cancelQueuedByContest 経由で drain。
const runCancelQueued = (
  contestId: ContestId,
  now: number
): Effect.Effect<StepOutcome, OperationExecutionError, BenchJobRepo> =>
  Effect.gen(function* () {
    const jobs = yield* BenchJobRepo
    const canceled = yield* jobs.cancelQueuedByContest(contestId, now)
    return { status: "succeeded", summary: `canceled ${canceled} queued job(s)` } satisfies StepOutcome
  }).pipe(Effect.catchAll((cause) => Effect.fail(new OperationExecutionError({ cause }))))

// wait_running step: countRunningByContest が 0 になるまで retry を返す。
// timeoutSweeper が stuck を failed に落とすので、この step は無限 retry に
// ならない前提(worker の maxAttempts に注意)。実装は spec の「retry until
// count zero」に合わせ、retry_at=now+FINISH_WAIT_RUNNING_RETRY_MILLIS を返す。
const runWaitRunning = (
  contestId: ContestId,
  now: number
): Effect.Effect<StepOutcome, OperationExecutionError, BenchJobRepo> =>
  Effect.gen(function* () {
    const jobs = yield* BenchJobRepo
    const running = yield* jobs.countRunningByContest(contestId)
    if (running === 0) {
      return { status: "succeeded", summary: "no running jobs" } satisfies StepOutcome
    }
    return {
      status: "retry",
      retryAt: now + FINISH_WAIT_RUNNING_RETRY_MILLIS,
      summary: `waiting for ${running} running job(s)`
    } satisfies StepOutcome
  }).pipe(Effect.catchAll((cause) => Effect.fail(new OperationExecutionError({ cause }))))

// finish / backup Operation 共通の handler dispatcher。stepKey で分岐して
// 各 step 実装に flow を渡す。OperationHandlerRegistry は (kind, stepKey) で
// lookup するため、kind 別に同じ handler を map するのが単純明快。
export const makeContestFinalizationHandler: Effect.Effect<
  OperationHandler,
  never,
  ArtifactRepo | BackupPort | BenchJobRepo | ContestRepo | UuidGen
> = Effect.gen(function* () {
  const context = yield* Effect.context<
    ArtifactRepo | BackupPort | BenchJobRepo | ContestRepo | UuidGen
  >()
  const run = (step: OperationStep): Effect.Effect<StepOutcome, OperationExecutionError> =>
    Effect.gen(function* () {
      const parsed = parseFinishStepInput(step.inputSummary)
      if (parsed === null) {
        return { status: "blocked", summary: "invalid_step_input" } satisfies StepOutcome
      }
      const now = yield* Clock.currentTimeMillis
      switch (step.stepKey) {
        case FINISH_STEP_KEYS.cancelQueued:
          return yield* runCancelQueued(parsed.contestId, now)
        case FINISH_STEP_KEYS.waitRunning:
          return yield* runWaitRunning(parsed.contestId, now)
        case FINISH_STEP_KEYS.writeScoreboardJson:
          return yield* runArchiveStep({
            contestId: parsed.contestId,
            kind: "scoreboard",
            now
          })
        case FINISH_STEP_KEYS.writeScoreboardCsv:
          return yield* runArchiveStep({
            contestId: parsed.contestId,
            kind: "scoreboard_csv",
            now
          })
        case FINISH_STEP_KEYS.writeDbSnapshot:
          return yield* runArchiveStep({
            contestId: parsed.contestId,
            kind: "snapshot",
            now
          })
        case FINISH_STEP_KEYS.finishContest:
          return yield* runFinishContest(parsed.contestId, now)
        default:
          return { status: "blocked", summary: `unknown_step:${step.stepKey}` } satisfies StepOutcome
      }
    }).pipe(
      Effect.provide(context),
      // review round 3 finding 2: 内側 (runCancelQueued / runWaitRunning /
      // runArchiveStep / runFinishContest) が既に catchAll で OperationExecutionError
      // に畳んでいるため、外側の catchAll は typed error を再度包み直す dead
      // path になる。unexpected defect (throw) を OperationExecutionError に
      // 上げる catchAllDefect だけを残す。
      Effect.catchAllDefect((defect) => Effect.fail(new OperationExecutionError({ cause: defect })))
    )
  return { run }
})

// keep referenced from main.ts registry wiring
void Either
