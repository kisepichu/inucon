import { HttpApiBuilder } from "@effect/platform"
import { Effect } from "effect"
import {
  api,
  ContestEditionConflict,
  ContestRevisionConflict,
  CurrentUser,
  InvalidContestSchedule,
  InvalidContestTransition,
  NotFound,
  OperationalContestConflict
} from "shared"
import {
  beginContestPreparation,
  cancelContest,
  copyContestRoster,
  createContestDraft,
  getAdminContest,
  listAdminContests,
  updateContestDraft
} from "../../../application/usecases/contestAdmin.js"

// Task 5: contestAdminGroup(/api/admin/contests …)の handler 実装。
// - domain / usecase 側のエラーを shared/api の TaggedError にマッピングする
//   (ContestNotFound → 404、Conflict 系 → 409、Schedule → 422)。
// - AdminOnly 認可は shared/api の group 定義側で middleware として付いている
//   ため、handler では CurrentUser を actorUserId として使うだけ。
export const ContestAdminLive = HttpApiBuilder.group(api, "contestAdmin", (handlers) =>
  handlers
    .handle("listAdminContests", ({ urlParams }) =>
      listAdminContests({ includeCanceled: urlParams.includeCanceled === "true" }).pipe(
        Effect.orDie
      )
    )
    .handle("createContestDraft", ({ payload }) =>
      createContestDraft(payload).pipe(
        Effect.catchTags({
          ContestEditionConflict: (e) => Effect.fail(new ContestEditionConflict({ edition: e.edition })),
          InvalidContestSchedule: (e) => Effect.fail(new InvalidContestSchedule({ reason: e.reason }))
        }),
        Effect.orDie
      )
    )
    .handle("getAdminContest", ({ path }) =>
      getAdminContest(path.contestId).pipe(
        Effect.catchTag("ContestNotFound", () => Effect.fail(new NotFound())),
        Effect.orDie
      )
    )
    .handle("updateContestDraft", ({ path, payload }) =>
      updateContestDraft(path.contestId, payload.expectedRevision, payload.patch).pipe(
        Effect.catchTags({
          ContestNotFound: () => Effect.fail(new NotFound()),
          ContestRevisionConflict: (e) =>
            Effect.fail(new ContestRevisionConflict({ expected: e.expected, actual: e.actual })),
          InvalidContestTransition: (e) =>
            Effect.fail(new InvalidContestTransition({ from: e.from, to: e.to })),
          InvalidContestSchedule: (e) => Effect.fail(new InvalidContestSchedule({ reason: e.reason })),
          OperationalContestConflict: () => Effect.fail(new OperationalContestConflict())
        }),
        Effect.orDie
      )
    )
    .handle("beginContestPreparation", ({ path, payload }) =>
      Effect.gen(function* () {
        const actor = yield* CurrentUser
        return yield* beginContestPreparation(path.contestId, payload.expectedRevision, actor.id)
      }).pipe(
        Effect.catchTags({
          ContestNotFound: () => Effect.fail(new NotFound()),
          ContestRevisionConflict: (e) =>
            Effect.fail(new ContestRevisionConflict({ expected: e.expected, actual: e.actual })),
          OperationalContestConflict: () => Effect.fail(new OperationalContestConflict()),
          InvalidContestTransition: (e) =>
            Effect.fail(new InvalidContestTransition({ from: e.from, to: e.to })),
          InvalidContestSchedule: (e) => Effect.fail(new InvalidContestSchedule({ reason: e.reason }))
        }),
        Effect.orDie
      )
    )
    .handle("cancelAdminContest", ({ path, payload }) =>
      Effect.gen(function* () {
        const actor = yield* CurrentUser
        return yield* cancelContest(path.contestId, payload.expectedRevision, actor.id)
      }).pipe(
        Effect.catchTags({
          ContestNotFound: () => Effect.fail(new NotFound()),
          ContestRevisionConflict: (e) =>
            Effect.fail(new ContestRevisionConflict({ expected: e.expected, actual: e.actual })),
          InvalidContestTransition: (e) =>
            Effect.fail(new InvalidContestTransition({ from: e.from, to: e.to })),
          // cancelContest の usecase 型には schedule/operational も含まれるが、
          // 実行時に返ることは無いため defect にして即クラッシュさせる
          // (ハンドラで silently 消すと契約と実装のズレに気付けなくなる)。
          InvalidContestSchedule: (e) => Effect.dieMessage(`unexpected InvalidContestSchedule from cancel: ${e.reason}`),
          OperationalContestConflict: () =>
            Effect.dieMessage("unexpected OperationalContestConflict from cancel")
        }),
        Effect.orDie
      )
    )
    .handle("copyContestRoster", ({ path, payload }) =>
      copyContestRoster(payload.sourceContestId, path.contestId).pipe(
        Effect.catchTags({
          ContestNotFound: () => Effect.fail(new NotFound()),
          InvalidContestTransition: (e) =>
            Effect.fail(new InvalidContestTransition({ from: e.from, to: e.to })),
          // copyContestRoster は revision / schedule / operational を返さないが、
          // union 型上ここに現れる。実行時に来たら defect にする。
          ContestRevisionConflict: (e) =>
            Effect.dieMessage(`unexpected ContestRevisionConflict from copyRoster: ${e.actual}`),
          InvalidContestSchedule: (e) =>
            Effect.dieMessage(`unexpected InvalidContestSchedule from copyRoster: ${e.reason}`),
          OperationalContestConflict: () =>
            Effect.dieMessage("unexpected OperationalContestConflict from copyRoster")
        }),
        Effect.orDie
      )
    )
)
