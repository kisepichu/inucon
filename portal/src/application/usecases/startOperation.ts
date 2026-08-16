import { Clock, Effect, Option } from "effect"
import { startContest } from "../../domain/contest.js"
import type { Contest } from "../../domain/contest.js"
import type { ContestId } from "../../domain/ids.js"
import type { OperationHandler } from "../ports.js"
import {
  BackupPort,
  BenchJobRepo,
  CloudflarePort,
  ContestRepo,
  InstanceRepo,
  OperationExecutionError,
  ProxmoxPort,
  ResourceBindingRepo,
  RunnerAgentRepo,
  RunnerConfig
} from "../ports.js"
import { computeReadiness, START_REQUIRED_CHECK_KEYS } from "./readiness.js"
import type { StepOutcome } from "./operations.js"
import { START_CONTEST_STEP_KEY } from "./contestAdmin.js"

// Task 10 §Step 6: start Operation の 1-step handler。
//
// spec 「Do not trust the last UI readiness response. POST start enqueues an
// audited `start` Operation carrying the expected Contest revision; its single
// step recomputes every required check immediately before `saveIfRevision`.
// Map a blocked ReadinessFailed step to an Operation detail containing failing
// check keys only, never provider responses or email values.」
//
// 実行順:
//   1. inputSummary から contestId / expectedRevision を復元する。
//   2. Contest を再読し、preparing でなければ blocked (別 admin が状態を触った)。
//   3. revision が一致していなければ blocked (楽観ロック; sanitized code は
//      "invalid_transition" 相当を返す)。
//   4. computeReadiness を再走。START_REQUIRED_CHECK_KEYS に含まれる key で
//      status != "pass" があれば blocked、details.failingChecks に key 集合を
//      載せる (生 email / bearer / provider レスポンスは絶対に含めない)。
//   5. 全 required=pass なら scheduledEndAt <= now を追加チェック
//      (spec Step 2: 「scheduledEndAt <= now」も start-gate)。
//   6. domain の startContest(preparing → running) を実行し、
//      saveIfRevision で楽観ロック更新。成功したら succeeded。

interface StepInput {
  readonly contestId: ContestId
  readonly expectedRevision: number
}

const parseStepInput = (raw: string): StepInput | null => {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== "object" || parsed === null) return null
    if (!("contestId" in parsed) || !("expectedRevision" in parsed)) return null
    const cid = (parsed as Record<string, unknown>).contestId
    const rev = (parsed as Record<string, unknown>).expectedRevision
    if (typeof cid !== "string" || typeof rev !== "number") return null
    return { contestId: cid as ContestId, expectedRevision: rev }
  } catch {
    return null
  }
}

// spec: ReadinessFailed step は「failing check keys のみを詳細に載せる」。
// 現実装は blocked outcome の summary に固定文言 + failingChecks の配列を JSON
// で埋め、operations.getContestReadiness UI が summary をそのまま表示できる
// ようにする。生の provider レスポンス / email / bearer は絶対に埋めない。
const readinessSummary = (failingChecks: ReadonlyArray<string>): string =>
  `readiness gate failed: ${JSON.stringify(failingChecks)}`

export const makeStartContestHandler: Effect.Effect<
  OperationHandler,
  never,
  | BackupPort
  | BenchJobRepo
  | CloudflarePort
  | ContestRepo
  | InstanceRepo
  | ProxmoxPort
  | ResourceBindingRepo
  | RunnerAgentRepo
  | RunnerConfig
> = Effect.gen(function* () {
  const context = yield* Effect.context<
    | BackupPort
    | BenchJobRepo
    | CloudflarePort
    | ContestRepo
    | InstanceRepo
    | ProxmoxPort
    | ResourceBindingRepo
    | RunnerAgentRepo
    | RunnerConfig
  >()
  return {
    run: (step) =>
      Effect.gen(function* () {
        const input = parseStepInput(step.inputSummary)
        if (input === null) {
          return {
            status: "blocked",
            summary: "invalid step input for start_contest"
          } satisfies StepOutcome
        }
        const contests = yield* ContestRepo
        const contest = yield* contests.findById(input.contestId)
        if (Option.isNone(contest)) {
          return {
            status: "blocked",
            summary: `contest ${input.contestId} not found`
          } satisfies StepOutcome
        }
        const current: Contest = contest.value
        if (current.status !== "preparing") {
          return {
            status: "blocked",
            summary: `contest status is ${current.status}, expected preparing`
          } satisfies StepOutcome
        }
        if (current.revision !== input.expectedRevision) {
          return {
            status: "blocked",
            summary: `contest revision drift (expected ${input.expectedRevision}, actual ${current.revision})`
          } satisfies StepOutcome
        }
        // readiness を再計算。ContestNotFound は上で既に排除しているので通常
        // Right のみだが、防御的に Either 化して handling する。
        const checksResult = yield* Effect.either(computeReadiness(input.contestId))
        if (checksResult._tag === "Left") {
          return {
            status: "blocked",
            summary: `contest ${input.contestId} vanished mid-check`
          } satisfies StepOutcome
        }
        const failing = checksResult.right
          .filter(
            (c) =>
              START_REQUIRED_CHECK_KEYS.includes(c.key) && c.status !== "pass"
          )
          .map((c) => c.key)
        if (failing.length > 0) {
          return {
            status: "blocked",
            summary: readinessSummary(failing)
          } satisfies StepOutcome
        }
        // scheduledEndAt <= now は readiness には載せず、start-only の追加 gate。
        // Contest には scheduledEndAt が非 None で入っている前提 (beginPreparation で強制)。
        const now = yield* Clock.currentTimeMillis
        const endAt = Option.getOrNull(current.scheduledEndAt)
        if (endAt !== null && endAt <= now) {
          return {
            status: "blocked",
            summary: `scheduledEndAt ${endAt} <= now ${now}`
          } satisfies StepOutcome
        }
        // preparing → running 遷移。line 112 で status === 'preparing' を
        // 確認済みなので startContest の onLeft は実質到達不能だが、review round 3 #1:
        // Effect.fail(OperationExecutionError) を投げると外側 catchAll が更に
        // OperationExecutionError で包み double-wrap になる。防御的に到達した
        // 場合は blocked outcome を直接返し、operator 判断待ちにする (worker は
        // blocked を retry しないため consistent な出口)。
        const startedEither = startContest(current, now)
        if (startedEither._tag === "Left") {
          return {
            status: "blocked",
            summary: `unexpected transition failure from ${current.status} to running`
          } satisfies StepOutcome
        }
        const started = startedEither.right
        const saveResult = yield* Effect.either(
          contests.saveIfRevision(started, input.expectedRevision)
        )
        if (saveResult._tag === "Left") {
          // review round 1 #1: RepoError (transient DB 故障) と
          // ContestRevisionConflict (楽観ロック競合) を混同しない。前者は
          // 「一時故障 → worker が retry」なので Effect.fail で外側 catchAll に
          // 投げ OperationExecutionError にラップ。後者だけを blocked に落として
          // operator 判断待ちにする (別 admin が saveIfRevision と race したケース)。
          if (saveResult.left._tag !== "ContestRevisionConflict") {
            return yield* Effect.fail(saveResult.left)
          }
          return {
            status: "blocked",
            summary: `saveIfRevision: revision conflict (expected ${saveResult.left.expected}, actual ${saveResult.left.actual})`
          } satisfies StepOutcome
        }
        return {
          status: "succeeded",
          summary: `contest ${input.contestId} started (revision ${saveResult.right.revision})`
        } satisfies StepOutcome
      }).pipe(
        Effect.provide(context),
        // Any lingering typed error (RepoError, InvalidContestTransition 等) は
        // handler の契約に合わせて OperationExecutionError に潰す。worker が
        // sanitize + retry / block を決める。
        Effect.catchAll((cause) => Effect.fail(new OperationExecutionError({ cause }))),
        Effect.catchAllDefect((defect) =>
          Effect.fail(new OperationExecutionError({ cause: defect }))
        )
      )
  }
})

// Task 10: main.ts の OperationHandlerRegistryLive が (kind, stepKey) で lookup
// するときに一致させるための constants export。
export { START_CONTEST_STEP_KEY }
