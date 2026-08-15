import { Clock, Effect, Either, Option } from "effect"
import { Contest, beginPreparation, cancelContest as cancelContestDomain } from "../../domain/contest.js"
import type { ContestStatus } from "../../domain/contest.js"
import {
  ContestEditionConflict,
  ContestRevisionConflict,
  InvalidContestSchedule,
  InvalidContestTransition,
  OperationalContestConflict
} from "../../domain/errors.js"
import { ContestId, TeamId } from "../../domain/ids.js"
import type { UserId } from "../../domain/ids.js"
import { Team } from "../../domain/team.js"
import { TeamInvite } from "../../domain/teamInvite.js"
import { ContestNotFound } from "../errors.js"
import {
  ContestRepo,
  InviteRepo,
  RepoError,
  TeamRepo,
  TransactionRunner,
  UuidGen
} from "../ports.js"

// Task 5: admin draft wizard 用の usecase 群。
//
// - createContestDraft: 新規 draft Contest を作る。edition partial unique に反すれば
//   ContestEditionConflict。schedule が入っていれば draft ステージでも整合性検査
//   (beginPreparation の予備検証)を行う。
// - updateContestDraft: draft / preparing の Contest に patch を当てる。revision +1、
//   楽観ロック競合は ContestRevisionConflict。running 以降は InvalidContestTransition。
// - copyContestRoster: source contest の teams / members / invites を target contest
//   に単一トランザクションで複製する(新しい team ID を採番)。
// - beginContestPreparation: draft -> preparing の遷移。revision + single-operational
//   partial unique の両方をリポジトリで検証。
// - cancelContest: draft / preparing -> canceled。team_invites は同一トランザクション
//   で全削除する(archive 化した Team に新規招待が消費されるのを防ぐため)。
// - listAdminContests / getAdminContest: canceled を含む admin 用参照。

export type ContestAdminError =
  | RepoError
  | ContestNotFound
  | ContestRevisionConflict
  | OperationalContestConflict
  | InvalidContestTransition
  | InvalidContestSchedule

export interface CreateContestDraftInput {
  readonly edition: number
  readonly name: string
  readonly problemKey: string
  readonly problemRevision: string
  readonly templateVmid: number
  readonly instanceQuota: number
  readonly scheduledStartAt: number | null
  readonly scheduledEndAt: number | null
  readonly accessClosesAt: number | null
  readonly cleanupAt: number | null
}

export interface DraftPatch {
  readonly name?: string
  readonly problemKey?: string
  readonly problemRevision?: string
  readonly templateVmid?: number
  readonly instanceQuota?: number
  readonly scheduledStartAt?: number | null
  readonly scheduledEndAt?: number | null
  readonly accessClosesAt?: number | null
  readonly cleanupAt?: number | null
}

// draft 作成/更新時に「入力されている分だけ」を beginPreparation と同じ順序で
// 検査する(全部揃わなくても draft 保存は許すため、null なら skip する)。
// beginPreparation が呼ばれるまでにすべて揃っていれば良い。
const validateScheduleShape = (
  scheduledStartAt: number | null,
  scheduledEndAt: number | null,
  accessClosesAt: number | null,
  cleanupAt: number | null
): Either.Either<void, InvalidContestSchedule> => {
  if (scheduledStartAt !== null && scheduledEndAt !== null && scheduledStartAt >= scheduledEndAt) {
    return Either.left(new InvalidContestSchedule({ reason: "start_not_before_end" }))
  }
  if (accessClosesAt !== null && scheduledEndAt !== null && accessClosesAt < scheduledEndAt) {
    return Either.left(new InvalidContestSchedule({ reason: "access_close_before_end" }))
  }
  // Task 5 review (finding 4): accessClosesAt が null のときも cleanupAt < end
  // を弾く。そうしないと「cleanup が end より早い」draft を保存できてしまい、
  // 後日 beginPreparation で missing_schedule として弾かれ、実際の順序違反が
  // 覆い隠される。access チェーンが揃っていない場合は end を暫定的な下限に使う。
  if (cleanupAt !== null && accessClosesAt !== null && cleanupAt < accessClosesAt) {
    return Either.left(new InvalidContestSchedule({ reason: "cleanup_before_access_close" }))
  }
  if (cleanupAt !== null && accessClosesAt === null && scheduledEndAt !== null && cleanupAt < scheduledEndAt) {
    return Either.left(new InvalidContestSchedule({ reason: "cleanup_before_access_close" }))
  }
  return Either.right(undefined)
}

export const createContestDraft = (
  input: CreateContestDraftInput
): Effect.Effect<
  Contest,
  RepoError | ContestEditionConflict | InvalidContestSchedule,
  ContestRepo | UuidGen
> =>
  Effect.gen(function* () {
    // Draft でも「順序が壊れている値」は先に弾く(edition のような partial unique
    // で先に 409 になっても、schedule 壊れは 422 の別カテゴリなので順序は問わない
    // が、ユーザー体験としては入力バリデーションを先に見せた方が親切)。
    yield* Either.match(
      validateScheduleShape(
        input.scheduledStartAt,
        input.scheduledEndAt,
        input.accessClosesAt,
        input.cleanupAt
      ),
      { onLeft: Effect.fail, onRight: Effect.succeed }
    )
    const uuid = yield* UuidGen
    const id = ContestId.make(yield* uuid.next)
    const contest = new Contest({
      id,
      edition: input.edition,
      name: input.name,
      problemKey: input.problemKey,
      problemRevision: input.problemRevision,
      templateVmid: input.templateVmid,
      status: "draft",
      instanceQuota: input.instanceQuota,
      scheduledStartAt: Option.fromNullable(input.scheduledStartAt),
      scheduledEndAt: Option.fromNullable(input.scheduledEndAt),
      accessClosesAt: Option.fromNullable(input.accessClosesAt),
      cleanupAt: Option.fromNullable(input.cleanupAt),
      accessClosedAt: Option.none(),
      cleanupCompletedAt: Option.none(),
      startedAt: Option.none(),
      finalizingAt: Option.none(),
      finishedAt: Option.none(),
      canceledAt: Option.none(),
      revision: 1
    })
    const repo = yield* ContestRepo
    // 作成する Contest は status="draft" 固定なので、ContestRepo.create の
    // single-operational partial unique 分岐(preparing/running/finalizing の
    // 判定)は決してトリガされない。OperationalContestConflict は create の
    // 戻り値としては返り得ないため、この usecase の error 型からは除外し、
    // catchTags 側でも handling しない(dead code)。
    yield* repo.create(contest).pipe(
      Effect.catchTag("OperationalContestConflict", (cause) =>
        // 万一発生した場合(port 実装の想定違反)は defect にして原因調査を強制する。
        Effect.dieMessage(`unexpected OperationalContestConflict on draft create: ${JSON.stringify(cause)}`)
      )
    )
    return contest
  })

const DRAFT_MUTABLE: ReadonlyArray<ContestStatus> = ["draft", "preparing"]

const loadForMutation = (
  contestId: ContestId
): Effect.Effect<Contest, ContestNotFound | RepoError, ContestRepo> =>
  Effect.gen(function* () {
    const repo = yield* ContestRepo
    return yield* repo.findById(contestId).pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new ContestNotFound()), onSome: Effect.succeed }))
    )
  })

export const updateContestDraft = (
  contestId: ContestId,
  expectedRevision: number,
  patch: DraftPatch
): Effect.Effect<Contest, ContestAdminError, ContestRepo> =>
  Effect.gen(function* () {
    const contest = yield* loadForMutation(contestId)
    if (!DRAFT_MUTABLE.includes(contest.status)) {
      return yield* Effect.fail(
        new InvalidContestTransition({ from: contest.status, to: "draft" })
      )
    }
    if (contest.revision !== expectedRevision) {
      return yield* Effect.fail(
        new ContestRevisionConflict({ expected: expectedRevision, actual: contest.revision })
      )
    }
    const merged = new Contest({
      ...contest,
      name: patch.name ?? contest.name,
      problemKey: patch.problemKey ?? contest.problemKey,
      problemRevision: patch.problemRevision ?? contest.problemRevision,
      templateVmid: patch.templateVmid ?? contest.templateVmid,
      instanceQuota: patch.instanceQuota ?? contest.instanceQuota,
      scheduledStartAt:
        patch.scheduledStartAt === undefined
          ? contest.scheduledStartAt
          : Option.fromNullable(patch.scheduledStartAt),
      scheduledEndAt:
        patch.scheduledEndAt === undefined
          ? contest.scheduledEndAt
          : Option.fromNullable(patch.scheduledEndAt),
      accessClosesAt:
        patch.accessClosesAt === undefined
          ? contest.accessClosesAt
          : Option.fromNullable(patch.accessClosesAt),
      cleanupAt:
        patch.cleanupAt === undefined ? contest.cleanupAt : Option.fromNullable(patch.cleanupAt),
      revision: contest.revision + 1
    })
    yield* Either.match(
      validateScheduleShape(
        Option.getOrNull(merged.scheduledStartAt),
        Option.getOrNull(merged.scheduledEndAt),
        Option.getOrNull(merged.accessClosesAt),
        Option.getOrNull(merged.cleanupAt)
      ),
      { onLeft: Effect.fail, onRight: Effect.succeed }
    )
    const repo = yield* ContestRepo
    return yield* repo.saveIfRevision(merged, expectedRevision)
  })

export const beginContestPreparation = (
  contestId: ContestId,
  expectedRevision: number,
  _actorUserId: UserId
): Effect.Effect<Contest, ContestAdminError, ContestRepo> =>
  Effect.gen(function* () {
    const contest = yield* loadForMutation(contestId)
    if (contest.revision !== expectedRevision) {
      return yield* Effect.fail(
        new ContestRevisionConflict({ expected: expectedRevision, actual: contest.revision })
      )
    }
    const prepared = yield* Either.match(beginPreparation(contest), {
      onLeft: Effect.fail,
      onRight: Effect.succeed
    })
    // single-operational partial unique index の TOCTOU 対策(Task 5 review
    // finding 1)。事前 getOperational で 0 を確認していても、SqlClient 越しの
    // 別トランザクションが先に「preparing に遷移」を commit する race がある。
    // その場合 saveIfRevision の UPDATE が
    // idx_contests_single_operational で UNIQUE 違反となり RepoError(500)
    // に畳まれるので、失敗時にもう一度 getOperational を読んで「別 contest が
    // 既に operational になっている」と判定できたら 409 OperationalContestConflict
    // に載せ替える。実際の SQLite エラー文字列に依存しない安全側の診断。
    const repo = yield* ContestRepo
    const preCheck = yield* repo.getOperational
    if (Option.isSome(preCheck) && preCheck.value.id !== contest.id) {
      return yield* Effect.fail(new OperationalContestConflict())
    }
    return yield* repo.saveIfRevision(prepared, expectedRevision).pipe(
      Effect.catchTag("RepoError", (cause) =>
        Effect.gen(function* () {
          const others = yield* repo.getOperational
          if (Option.isSome(others) && others.value.id !== contest.id) {
            return yield* Effect.fail(new OperationalContestConflict())
          }
          return yield* Effect.fail(cause)
        })
      )
    )
  })

export const cancelContest = (
  contestId: ContestId,
  expectedRevision: number,
  _actorUserId: UserId
): Effect.Effect<Contest, ContestAdminError, ContestRepo> =>
  Effect.gen(function* () {
    const contest = yield* loadForMutation(contestId)
    if (contest.revision !== expectedRevision) {
      return yield* Effect.fail(
        new ContestRevisionConflict({ expected: expectedRevision, actual: contest.revision })
      )
    }
    const now = yield* Clock.currentTimeMillis
    const canceled = yield* Either.match(cancelContestDomain(contest, now), {
      onLeft: Effect.fail,
      onRight: Effect.succeed
    })
    const repo = yield* ContestRepo
    // team_invites は Contest 行が canceled になったあとで消費されると
    // archive Team に新規メンバーが増えてしまうため、必ず同一トランザクション
    // で削除する(atomic 保証は SQL 側 saveIfRevisionAndPurgeInvites の担当)。
    return yield* repo.saveIfRevisionAndPurgeInvites(canceled, expectedRevision)
  })

export const copyContestRoster = (
  sourceContestId: ContestId,
  targetContestId: ContestId
): Effect.Effect<
  ReadonlyArray<Team>,
  ContestAdminError,
  ContestRepo | TeamRepo | InviteRepo | UuidGen | TransactionRunner
> =>
  Effect.gen(function* () {
    const contestRepo = yield* ContestRepo
    // target/source の存在確認は tx の外で早期に。存在すれば pre-check として
    // InvalidContestTransition を先に返す。ただし target の status は tx 内で
    // 再確認する(Task 5 re-review finding 1: この pre-check と tx 開始の間に
    // 別 admin が target を cancel してしまう TOCTOU があるため)。
    const source = yield* contestRepo.findById(sourceContestId).pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new ContestNotFound()), onSome: Effect.succeed }))
    )
    const target = yield* contestRepo.findById(targetContestId).pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new ContestNotFound()), onSome: Effect.succeed }))
    )
    if (!DRAFT_MUTABLE.includes(target.status)) {
      return yield* Effect.fail(
        new InvalidContestTransition({ from: target.status, to: "draft" })
      )
    }

    const teamRepo = yield* TeamRepo
    const inviteRepo = yield* InviteRepo
    const uuid = yield* UuidGen
    const tx = yield* TransactionRunner

    // Task 5 review finding 3: source の teams / members / invites 3 種と
    // target への書き込みを 1 トランザクションで括る。source が preparing で
    // 並行編集されているケースでも一貫スナップショットを保証する。
    return yield* tx.run(
      Effect.gen(function* () {
        // Task 5 re-review finding 1: TOCTOU 対策。pre-check の後・tx.run() 開始
        // までの間に別 admin が target を cancel していれば、canceled contest に
        // teams を INSERT してしまう。tx 内で target を読み直して status を
        // 再確認する(withTransaction 内なので他 tx の書き込みは可視化されないが、
        // 逆に自 tx より前に commit された cancel は反映されている)。
        const targetNow = yield* contestRepo.findById(targetContestId).pipe(
          Effect.flatMap(
            Option.match({ onNone: () => Effect.fail(new ContestNotFound()), onSome: Effect.succeed })
          )
        )
        if (!DRAFT_MUTABLE.includes(targetNow.status)) {
          return yield* Effect.fail(
            new InvalidContestTransition({ from: targetNow.status, to: "draft" })
          )
        }
        const sourceTeams = yield* teamRepo.listByContest(source.id)
        // team_id は新規採番、team_number は保持。
        const teamIdMap = new Map<TeamId, TeamId>()
        const newTeams: Array<Team> = []
        for (const t of sourceTeams) {
          const newId = TeamId.make(yield* uuid.next)
          teamIdMap.set(t.id, newId)
          newTeams.push(
            new Team({
              id: newId,
              contestId: target.id,
              name: t.name,
              teamNumber: t.teamNumber,
              desiredInstanceCount: t.desiredInstanceCount
            })
          )
        }

        // members は team ごとに listMembers → 新 teamId に載せ替え。
        const memberships: Array<{ teamId: TeamId; userId: UserId }> = []
        for (const t of sourceTeams) {
          const newId = teamIdMap.get(t.id)!
          const members = yield* teamRepo.listMembers(source.id, t.id)
          for (const m of members) {
            memberships.push({ teamId: newId, userId: m.id })
          }
        }

        // invites は contest スコープで一括読み出し。teamId 差し替え。
        const sourceInvites = yield* inviteRepo.listByContest(source.id)
        const newInvites: Array<TeamInvite> = sourceInvites.flatMap((i) => {
          const newTeamId = teamIdMap.get(i.teamId)
          if (newTeamId === undefined) return []
          return [
            new TeamInvite({
              contestId: target.id,
              githubLogin: i.githubLogin,
              teamId: newTeamId,
              email: i.email,
              invitedAt: i.invitedAt
            })
          ]
        })

        yield* teamRepo.copyRoster({
          targetContestId: target.id,
          teams: newTeams,
          memberships,
          invites: newInvites
        })

        return newTeams
      })
    )
    // TeamNumberConflict は呼び出し元(ContestAdmin ハンドラ)には露出させない
    // — target を draft 状態にした直後に呼ぶ前提のため、正常系では起きない。
    // 起きた場合は RepoError に畳んでおく(500)。
  }).pipe(
    Effect.catchTag("TeamNumberConflict", (cause) => Effect.fail(new RepoError({ cause })))
  )

export interface ListAdminContestsInput {
  readonly includeCanceled: boolean
}

export const listAdminContests = (
  input: ListAdminContestsInput
): Effect.Effect<ReadonlyArray<Contest>, RepoError, ContestRepo> =>
  ContestRepo.pipe(
    Effect.flatMap((repo) => repo.list),
    Effect.map((all) => (input.includeCanceled ? all : all.filter((c) => c.status !== "canceled")))
  )

export const getAdminContest = (
  contestId: ContestId
): Effect.Effect<Contest, ContestNotFound | RepoError, ContestRepo> =>
  ContestRepo.pipe(
    Effect.flatMap((repo) => repo.findById(contestId)),
    Effect.flatMap(
      Option.match({ onNone: () => Effect.fail(new ContestNotFound()), onSome: Effect.succeed })
    )
  )
