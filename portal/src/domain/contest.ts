import { Either, Option, Schema } from "effect"
import { ContestId } from "./ids.js"
import { InvalidContestSchedule, InvalidContestTransition } from "./errors.js"

// Task 1 (multi-edition lifecycle): 6-state contest status machine.
// 一方向遷移: draft -> preparing -> running -> finalizing -> finished
//             draft|preparing -> canceled
// 各 mutation は revision を +1 し、時刻を Option.some(now) で刻む。
export type ContestStatus = "draft" | "preparing" | "running" | "finalizing" | "finished" | "canceled"

export class Contest extends Schema.Class<Contest>("Contest")({
  id: ContestId,
  edition: Schema.Int.pipe(Schema.positive()),
  name: Schema.String,
  problemKey: Schema.String,
  problemRevision: Schema.String,
  templateVmid: Schema.Int.pipe(Schema.positive()),
  status: Schema.Literal("draft", "preparing", "running", "finalizing", "finished", "canceled"),
  // チームごとのインスタンス上限(Phase 3、スペック §Instance 集約 不変条件1)。
  instanceQuota: Schema.Int.pipe(Schema.positive()),
  // スケジュール(admin が draft で設定 → beginPreparation の要件)。全部
  // epoch ms。domain と DB はどちらも Option / NULL で unset を表す。
  scheduledStartAt: Schema.OptionFromNullOr(Schema.Int),
  scheduledEndAt: Schema.OptionFromNullOr(Schema.Int),
  accessClosesAt: Schema.OptionFromNullOr(Schema.Int),
  // Task 12 の cleanup Operation の到達目標時刻。accessClosesAt 以降でなければ
  // ならない(cleanupAt < accessClosesAt は beginPreparation で reject)。
  cleanupAt: Schema.OptionFromNullOr(Schema.Int),
  // 実際に revoke_access / cleanup Operation が succeed したときに刻む
  // (scheduler の due 述語は accessClosesAt <= now AND accessClosedAt IS NULL、
  // 同様に cleanupAt <= now AND cleanupCompletedAt IS NULL、Task 12)。
  accessClosedAt: Schema.OptionFromNullOr(Schema.Int),
  cleanupCompletedAt: Schema.OptionFromNullOr(Schema.Int),
  // 状態遷移の実時刻。startContest/beginFinalization/finishContest/cancelContest
  // が対応するフィールドに Option.some(now) を書く。
  startedAt: Schema.OptionFromNullOr(Schema.Int),
  finalizingAt: Schema.OptionFromNullOr(Schema.Int),
  finishedAt: Schema.OptionFromNullOr(Schema.Int),
  canceledAt: Schema.OptionFromNullOr(Schema.Int),
  // 楽観排他用リビジョン。beginPreparation 以降のすべての成功 mutation で +1。
  revision: Schema.Int.pipe(Schema.positive())
}) {}

const bump = (
  contest: Contest,
  fields: Omit<Partial<Contest>, "id" | "revision">
): Contest => new Contest({ ...contest, ...fields, revision: contest.revision + 1 })

// draft -> preparing: scheduledStartAt/scheduledEndAt/accessClosesAt を全て
// 設定していること、time order(start < end <= accessClose、cleanupAt が
// あれば accessClose <= cleanupAt)が満たされていること。
export const beginPreparation = (
  contest: Contest
): Either.Either<Contest, InvalidContestTransition | InvalidContestSchedule> => {
  if (contest.status !== "draft") {
    return Either.left(new InvalidContestTransition({ from: contest.status, to: "preparing" }))
  }
  const start = Option.getOrNull(contest.scheduledStartAt)
  const end = Option.getOrNull(contest.scheduledEndAt)
  const accessClose = Option.getOrNull(contest.accessClosesAt)
  if (start === null || end === null || accessClose === null) {
    return Either.left(new InvalidContestSchedule({ reason: "missing_schedule" }))
  }
  if (start >= end) {
    return Either.left(new InvalidContestSchedule({ reason: "start_not_before_end" }))
  }
  if (accessClose < end) {
    return Either.left(new InvalidContestSchedule({ reason: "access_close_before_end" }))
  }
  const cleanupAt = Option.getOrNull(contest.cleanupAt)
  if (cleanupAt !== null && cleanupAt < accessClose) {
    return Either.left(new InvalidContestSchedule({ reason: "cleanup_before_access_close" }))
  }
  return Either.right(bump(contest, { status: "preparing" }))
}

// preparing -> running。startedAt を刻む(admin の明示 start 操作)。
export const startContest = (
  contest: Contest,
  now: number
): Either.Either<Contest, InvalidContestTransition> =>
  contest.status === "preparing"
    ? Either.right(bump(contest, { status: "running", startedAt: Option.some(now) }))
    : Either.left(new InvalidContestTransition({ from: contest.status, to: "running" }))

// running -> finalizing。finalizingAt を刻む(scheduler の scheduledEndAt
// 到達自動遷移、または compat な finishContestUsecase 経由)。
export const beginFinalization = (
  contest: Contest,
  now: number
): Either.Either<Contest, InvalidContestTransition> =>
  contest.status === "running"
    ? Either.right(bump(contest, { status: "finalizing", finalizingAt: Option.some(now) }))
    : Either.left(new InvalidContestTransition({ from: contest.status, to: "finalizing" }))

// finalizing -> finished。finishedAt を刻む(scoreboard 確定・archive 保存が
// 済んだあとに Operation の finish_contest step が呼ぶ、Task 11)。
export const finishContest = (
  contest: Contest,
  now: number
): Either.Either<Contest, InvalidContestTransition> =>
  contest.status === "finalizing"
    ? Either.right(bump(contest, { status: "finished", finishedAt: Option.some(now) }))
    : Either.left(new InvalidContestTransition({ from: contest.status, to: "finished" }))

// draft|preparing -> canceled。canceledAt を刻む。
export const cancelContest = (
  contest: Contest,
  now: number
): Either.Either<Contest, InvalidContestTransition> =>
  contest.status === "draft" || contest.status === "preparing"
    ? Either.right(bump(contest, { status: "canceled", canceledAt: Option.some(now) }))
    : Either.left(new InvalidContestTransition({ from: contest.status, to: "canceled" }))
