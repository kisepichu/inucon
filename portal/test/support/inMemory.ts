import { Context, Effect, Either, Layer, Option, Ref } from "effect"
import { createHash } from "node:crypto"
import { promises as fsp } from "node:fs"
import { join as pathJoin, resolve as pathResolve, sep as pathSep } from "node:path"
import { BackupError as _BackupErrorTag } from "../../src/application/ports.js"
import type { BenchJobPurpose } from "../../src/domain/benchJob.js"
import { BenchJob, cancelJob, failJob, finishJob, recordProgress, startJob } from "../../src/domain/benchJob.js"
import type { Contest } from "../../src/domain/contest.js"
import {
  CannotCancelRunning,
  ContestEditionConflict,
  ContestRevisionConflict,
  DuplicateInstanceIndex,
  InvalidJobTransition,
  OperationalContestConflict,
  TeamJobAlreadyQueued
} from "../../src/domain/errors.js"
import type { BenchJobId, ContestId, InstanceId, OperationId, OperationStepId, ResourceBindingId, TeamId } from "../../src/domain/ids.js"
import { UserId } from "../../src/domain/ids.js"
import { Instance } from "../../src/domain/instance.js"
import { User } from "../../src/domain/user.js"
import type { Team } from "../../src/domain/team.js"
import type { TeamInvite } from "../../src/domain/teamInvite.js"
import { ResourceBinding } from "../../src/domain/resourceBinding.js"
import { Operation, OperationStep, isOperationUnfinished } from "../../src/domain/operation.js"
import type { NewOperation, SanitizedOperationError } from "../../src/domain/operation.js"
import { InvalidOperationTransition } from "../../src/domain/errors.js"
import { MemberConflict, ProvisionInProgress, QuotaExceeded } from "../../src/application/errors.js"
import {
  AmbiguousAccessPolicy,
  BackupError,
  BackupPort,
  BenchJobRepo,
  CloudflareError,
  CloudflarePort,
  ContestRepo,
  GithubKeysError,
  GithubKeysPort,
  InstanceRepo,
  InviteRepo,
  ModeTransitionTimeout,
  OperationInProgress,
  OperationRepo,
  ProvisioningConfig,
  ProvisionTimeout,
  ProxmoxError,
  ProxmoxPort,
  RepoError,
  ResourceBindingRepo,
  RunnerAgentRepo,
  RunnerConfig,
  SessionRepo,
  TeamRepo,
  TransactionRunner,
  UserRepo,
  UuidGen
} from "../../src/application/ports.js"
import type { ProxmoxInfrastructureInventory } from "../../src/application/ports.js"

// テスト専用のインメモリ port 実装。すべて Ref ベースで、ports.ts のコメントに
// 書かれた意味論(TOCTOU 回避 / 全体 running 1 本制約)を素直に再現する。
// 本番実装(SQLite、Task 4)とは別物 — ここでの「アトミック性」は Ref の単一
// update 呼び出し内で読み取り+書き込みを完結させることで模している。

export const UuidGenTest: Layer.Layer<UuidGen> = Layer.effect(
  UuidGen,
  Effect.gen(function* () {
    const counter = yield* Ref.make(0)
    return {
      next: Ref.updateAndGet(counter, (n) => n + 1).pipe(Effect.map((n) => `test-uuid-${n}`))
    }
  })
)

// Task 5 review finding 3: in-memory テストではトランザクション境界を
// 持たないため、effect をそのまま実行する passthrough 実装。実行順は Ref の
// 更新順に決まるので、read → write の一貫性検証は他の repo 実装(SQL)の
// migration/http テストが担当する。
export const TransactionRunnerTest: Layer.Layer<TransactionRunner> = Layer.succeed(
  TransactionRunner,
  { run: (effect) => effect }
)

// Task 3: contest スコープの ContestRepo。initial に複数 contest を渡せる。
// getOperational は preparing/running/finalizing 1 行、getDisplay は
// running/finalizing > 最新 finished > preparing の優先順(canceled は除外)。
export const makeContestRepoTest = (initial: ReadonlyArray<Contest> = []): Layer.Layer<ContestRepo> =>
  Layer.effect(
    ContestRepo,
    Effect.gen(function* () {
      const ref = yield* Ref.make<ReadonlyArray<Contest>>(initial)
      const pickDisplay = (cs: ReadonlyArray<Contest>): Option.Option<Contest> => {
        const op = cs.find((c) => c.status === "running" || c.status === "finalizing")
        if (op !== undefined) return Option.some(op)
        const finished = cs
          .filter((c) => c.status === "finished")
          .sort((a, b) => {
            const bAt = Option.getOrElse(b.finishedAt, () => 0) - Option.getOrElse(a.finishedAt, () => 0)
            return bAt !== 0 ? bAt : b.edition - a.edition
          })
        if (finished[0] !== undefined) return Option.some(finished[0])
        const prep = cs.find((c) => c.status === "preparing")
        return prep !== undefined ? Option.some(prep) : Option.none()
      }
      return {
        list: Ref.get(ref).pipe(Effect.map((cs) => [...cs].sort((a, b) => b.edition - a.edition))),
        findById: (id: ContestId) =>
          Ref.get(ref).pipe(Effect.map((cs) => Option.fromNullable(cs.find((c) => c.id === id)))),
        getOperational: Ref.get(ref).pipe(
          Effect.map((cs) =>
            Option.fromNullable(
              cs.find((c) => c.status === "preparing" || c.status === "running" || c.status === "finalizing")
            )
          )
        ),
        getDisplay: Ref.get(ref).pipe(Effect.map(pickDisplay)),
        create: (c: Contest) =>
          Ref.modify(
            ref,
            (
              cs
            ): readonly [
              Either.Either<void, ContestEditionConflict | OperationalContestConflict>,
              ReadonlyArray<Contest>
            ] => {
              const editionConflict = cs.some((x) => x.edition === c.edition && x.status !== "canceled")
              if (editionConflict && c.status !== "canceled") {
                return [Either.left(new ContestEditionConflict({ edition: c.edition })), cs]
              }
              const operationalConflict =
                (c.status === "preparing" || c.status === "running" || c.status === "finalizing") &&
                cs.some((x) => x.status === "preparing" || x.status === "running" || x.status === "finalizing")
              if (operationalConflict) {
                return [Either.left(new OperationalContestConflict()), cs]
              }
              return [Either.right(undefined), [...cs, c]]
            }
          ).pipe(Effect.flatMap(Either.match({ onLeft: Effect.fail, onRight: Effect.succeed }))),
        saveIfRevision: (c: Contest, expectedRevision: number) =>
          Ref.modify(
            ref,
            (cs): readonly [Either.Either<Contest, ContestRevisionConflict>, ReadonlyArray<Contest>] => {
              const existing = cs.find((x) => x.id === c.id)
              if (existing === undefined) {
                return [Either.left(new ContestRevisionConflict({ expected: expectedRevision, actual: 0 })), cs]
              }
              if (existing.revision !== expectedRevision) {
                return [
                  Either.left(new ContestRevisionConflict({ expected: expectedRevision, actual: existing.revision })),
                  cs
                ]
              }
              return [Either.right(c), cs.map((x) => (x.id === c.id ? c : x))]
            }
          ).pipe(Effect.flatMap(Either.match({ onLeft: Effect.fail, onRight: Effect.succeed }))),
        // Task 5: makeContestRepoTest 単体では team_invites 側と ref を共有しない
        // ため、purge は no-op(戻り値の Contest 更新だけ)。invite 削除まで
        // 検証したいテストは shared-state な makeContestAdminReposTest を使う。
        saveIfRevisionAndPurgeInvites: (c: Contest, expectedRevision: number) =>
          Ref.modify(
            ref,
            (cs): readonly [Either.Either<Contest, ContestRevisionConflict>, ReadonlyArray<Contest>] => {
              const existing = cs.find((x) => x.id === c.id)
              if (existing === undefined) {
                return [Either.left(new ContestRevisionConflict({ expected: expectedRevision, actual: 0 })), cs]
              }
              if (existing.revision !== expectedRevision) {
                return [
                  Either.left(new ContestRevisionConflict({ expected: expectedRevision, actual: existing.revision })),
                  cs
                ]
              }
              return [Either.right(c), cs.map((x) => (x.id === c.id ? c : x))]
            }
          ).pipe(Effect.flatMap(Either.match({ onLeft: Effect.fail, onRight: Effect.succeed })))
      }
    })
  )

interface ScopedMember {
  readonly contestId: ContestId
  readonly teamId: TeamId
  readonly userId: UserId
}

export const makeTeamRepoTest = (args: {
  teams: ReadonlyArray<Team>
  memberships?: ReadonlyArray<ScopedMember>
  users?: ReadonlyArray<User>
}): Layer.Layer<TeamRepo> =>
  Layer.effect(
    TeamRepo,
    Effect.gen(function* () {
      const teamsRef = yield* Ref.make(args.teams)
      const membersRef = yield* Ref.make<ReadonlyArray<ScopedMember>>(args.memberships ?? [])
      const usersRef = yield* Ref.make(args.users ?? [])
      return {
        listByContest: (contestId: ContestId) =>
          Ref.get(teamsRef).pipe(
            Effect.map((teams) =>
              teams.filter((t) => t.contestId === contestId).sort((a, b) => a.teamNumber - b.teamNumber)
            )
          ),
        findById: (contestId: ContestId, id: TeamId) =>
          Ref.get(teamsRef).pipe(
            Effect.map((teams) =>
              Option.fromNullable(teams.find((t) => t.id === id && t.contestId === contestId))
            )
          ),
        findByUserId: (contestId: ContestId, userId: UserId) =>
          Effect.gen(function* () {
            const members = yield* Ref.get(membersRef)
            const teams = yield* Ref.get(teamsRef)
            const membership = members.find((m) => m.contestId === contestId && m.userId === userId)
            if (membership === undefined) return Option.none<Team>()
            return Option.fromNullable(
              teams.find((t) => t.id === membership.teamId && t.contestId === contestId)
            )
          }),
        create: (t: Team) => Ref.update(teamsRef, (teams) => [...teams, t]),
        // Task 2/3 レビュー: 別チーム所属の user を含む userIds が渡された場合
        // (usecases 側 pre-check と concurrent addMember の race で起こり得る)、
        // SQL 版は UNIQUE(contest_id, user_id) 違反を MemberConflict に変換する。
        // in-memory 版も同じ契約で失敗する。
        setMembers: (contestId: ContestId, teamId: TeamId, userIds: ReadonlyArray<UserId>) =>
          Effect.gen(function* () {
            const membersBefore = yield* Ref.get(membersRef)
            const users = yield* Ref.get(usersRef)
            const existingInTarget = new Set(
              membersBefore
                .filter((m) => m.contestId === contestId && m.teamId === teamId)
                .map((m) => m.userId)
            )
            const incomingIds = new Set(userIds.filter((id) => !existingInTarget.has(id)))
            const conflicts = membersBefore
              .filter((m) => m.contestId === contestId && m.teamId !== teamId && incomingIds.has(m.userId))
              .map((m) => users.find((u) => u.id === m.userId)?.githubLogin)
              .filter((login): login is string => login !== undefined)
            if (conflicts.length > 0) {
              return yield* Effect.fail(new MemberConflict({ logins: conflicts }))
            }
            yield* Ref.update(membersRef, (members) => [
              ...members.filter((m) => !(m.contestId === contestId && m.teamId === teamId)),
              ...userIds.map((userId) => ({ contestId, teamId, userId }))
            ])
          }),
        // 単一メンバー追加(招待フロー)。scoped unique(contest_id, user_id)は
        // 同一 contest 内でのみユニーク。異 contest には並行して所属可能。
        addMember: (contestId: ContestId, teamId: TeamId, userId: UserId) =>
          Ref.modify(
            membersRef,
            (members): readonly [boolean, ReadonlyArray<ScopedMember>] => {
              if (members.some((m) => m.contestId === contestId && m.userId === userId)) {
                return [false, members]
              }
              return [true, [...members, { contestId, teamId, userId }]]
            }
          ),
        listMembers: (contestId: ContestId, teamId: TeamId) =>
          Effect.gen(function* () {
            const members = yield* Ref.get(membersRef)
            const users = yield* Ref.get(usersRef)
            const memberIds = new Set(
              members
                .filter((m) => m.contestId === contestId && m.teamId === teamId)
                .map((m) => m.userId)
            )
            return users.filter((u) => memberIds.has(u.id))
          }),
        // Task 5: makeTeamRepoTest 単体では team_invites を持たないため、
        // invites 引数は無視して teams + memberships のみ書き込む。invites も
        // 含めて検証したいテストは shared-state な makeContestAdminReposTest を使う。
        copyRoster: ({ targetContestId, teams: newTeams, memberships }) =>
          Effect.gen(function* () {
            yield* Ref.update(teamsRef, (existing) => [...existing, ...newTeams])
            yield* Ref.update(membersRef, (existing) => [
              ...existing,
              ...memberships.map((m) => ({ contestId: targetContestId, teamId: m.teamId, userId: m.userId }))
            ])
          })
      }
    })
  )

// InviteRepo(migration 0005: PK = (contest_id, github_login))。create は
// 同一 (contestId, githubLogin) の upsert(team/email 上書き)、異 contest は
// 別行として共存する。contests を渡すと listByGithubLoginForLiveContests が
// draft/preparing/running/finalizing のみ返し、SQL 実装と同じ契約になる。
// contests 未指定なら全 invite を live 扱いにする(旧テストとの後方互換)。
export const makeInviteRepoTest = (
  initial: ReadonlyArray<TeamInvite> = [],
  contests?: ReadonlyArray<Contest>
): Layer.Layer<InviteRepo> =>
  Layer.effect(
    InviteRepo,
    Effect.gen(function* () {
      const ref = yield* Ref.make(initial)
      const liveIds =
        contests === undefined
          ? undefined
          : new Set(
              contests
                .filter(
                  (c) =>
                    c.status === "draft" ||
                    c.status === "preparing" ||
                    c.status === "running" ||
                    c.status === "finalizing"
                )
                .map((c) => c.id)
            )
      return {
        create: (invite: TeamInvite) =>
          Ref.update(ref, (invites) => [
            ...invites.filter(
              (i) => !(i.contestId === invite.contestId && i.githubLogin === invite.githubLogin)
            ),
            invite
          ]),
        findByGithubLogin: (contestId: ContestId, githubLogin: string) =>
          Ref.get(ref).pipe(
            Effect.map((invites) =>
              Option.fromNullable(
                invites.find((i) => i.contestId === contestId && i.githubLogin === githubLogin)
              )
            )
          ),
        delete: (contestId: ContestId, githubLogin: string) =>
          Ref.update(ref, (invites) =>
            invites.filter((i) => !(i.contestId === contestId && i.githubLogin === githubLogin))
          ),
        listByTeam: (contestId: ContestId, teamId: TeamId) =>
          Ref.get(ref).pipe(
            Effect.map((invites) => invites.filter((i) => i.contestId === contestId && i.teamId === teamId))
          ),
        listByContest: (contestId: ContestId) =>
          Ref.get(ref).pipe(
            Effect.map((invites) =>
              invites.filter((i) => i.contestId === contestId).slice().sort((a, b) => a.invitedAt - b.invitedAt)
            )
          ),
        // Task 3 Step 5: live contest(draft/preparing/running/finalizing)のみ。
        // contests 未指定なら「全部 live」フォールバックで旧テスト互換を保つ。
        // invited_at ASC でソートするのは SQL 側と同一契約
        // (auth の for-of ループ末尾の email が users.email を決定論に上書き)。
        listByGithubLoginForLiveContests: (githubLogin: string) =>
          Ref.get(ref).pipe(
            Effect.map((invites) =>
              invites
                .filter((i) => i.githubLogin === githubLogin && (liveIds === undefined || liveIds.has(i.contestId)))
                .slice()
                .sort((a, b) => a.invitedAt - b.invitedAt)
            )
          )
      }
    })
  )

// makeInviteReposTest: users/sessions/teams/invites を単一ストアで共有する。
// contests パラメータで live 判定を持たせ、listByGithubLoginForLiveContests が
// 正しくフィルタする(auth 初ログイン consumeLiveInvites のテストで使う)。
export const makeInviteReposTest = (args: {
  teams: ReadonlyArray<Team>
  contests?: ReadonlyArray<Contest>
  users?: ReadonlyArray<User>
  memberships?: ReadonlyArray<ScopedMember>
  invites?: ReadonlyArray<TeamInvite>
}): Layer.Layer<UserRepo | SessionRepo | TeamRepo | InviteRepo> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const usersRef = yield* Ref.make<ReadonlyArray<User>>(args.users ?? [])
      const membersRef = yield* Ref.make<ReadonlyArray<ScopedMember>>(args.memberships ?? [])
      const teamsRef = yield* Ref.make<ReadonlyArray<Team>>(args.teams)
      const invitesRef = yield* Ref.make<ReadonlyArray<TeamInvite>>(args.invites ?? [])
      const contestsRef = yield* Ref.make<ReadonlyArray<Contest>>(args.contests ?? [])
      const sessionsRef = yield* Ref.make<
        ReadonlyArray<{ sessionId: string; userId: UserId; expiresAt: number }>
      >([])
      const counter = yield* Ref.make(0)

      const userRepo: Context.Tag.Service<UserRepo> = {
        upsertByGithub: (u) =>
          Effect.gen(function* () {
            const n = yield* Ref.updateAndGet(counter, (c) => c + 1)
            return yield* Ref.modify(usersRef, (users): readonly [User, ReadonlyArray<User>] => {
              const existing = users.find((x) => x.githubId === u.githubId)
              if (existing !== undefined) {
                const updated = new User({
                  ...existing,
                  githubLogin: u.githubLogin,
                  displayName: u.displayName,
                  isAdmin: u.isAdmin
                })
                return [updated, users.map((x) => (x.githubId === u.githubId ? updated : x))]
              }
              const created = new User({
                id: UserId.make(`test-user-${n}`),
                githubId: u.githubId,
                githubLogin: u.githubLogin,
                displayName: u.displayName,
                isAdmin: u.isAdmin,
                email: Option.none()
              })
              return [created, [...users, created]]
            })
          }),
        findById: (id) =>
          Ref.get(usersRef).pipe(Effect.map((users) => Option.fromNullable(users.find((u) => u.id === id)))),
        findManyByGithubLogins: (logins) =>
          Ref.get(usersRef).pipe(Effect.map((users) => users.filter((u) => logins.includes(u.githubLogin)))),
        setEmail: (id, email) =>
          Ref.update(usersRef, (users) =>
            users.map((u) => (u.id === id ? new User({ ...u, email: Option.some(email) }) : u))
          )
      }

      const sessionRepo: Context.Tag.Service<SessionRepo> = {
        create: (userId, expiresAt) =>
          Effect.gen(function* () {
            const n = yield* Ref.updateAndGet(counter, (c) => c + 1)
            const sessionId = `test-session-${n}`
            yield* Ref.update(sessionsRef, (sessions) => [...sessions, { sessionId, userId, expiresAt }])
            return sessionId
          }),
        findValidUser: (sessionId, now) =>
          Effect.gen(function* () {
            const sessions = yield* Ref.get(sessionsRef)
            const session = sessions.find((s) => s.sessionId === sessionId && s.expiresAt > now)
            if (session === undefined) return Option.none<User>()
            const users = yield* Ref.get(usersRef)
            return Option.fromNullable(users.find((u) => u.id === session.userId))
          }),
        delete: (sessionId) =>
          Ref.update(sessionsRef, (sessions) => sessions.filter((s) => s.sessionId !== sessionId))
      }

      const teamRepo: Context.Tag.Service<TeamRepo> = {
        listByContest: (contestId) =>
          Ref.get(teamsRef).pipe(
            Effect.map((teams) =>
              teams.filter((t) => t.contestId === contestId).sort((a, b) => a.teamNumber - b.teamNumber)
            )
          ),
        findById: (contestId, id) =>
          Ref.get(teamsRef).pipe(
            Effect.map((teams) =>
              Option.fromNullable(teams.find((t) => t.id === id && t.contestId === contestId))
            )
          ),
        findByUserId: (contestId, userId) =>
          Effect.gen(function* () {
            const members = yield* Ref.get(membersRef)
            const teams = yield* Ref.get(teamsRef)
            const membership = members.find((m) => m.contestId === contestId && m.userId === userId)
            if (membership === undefined) return Option.none<Team>()
            return Option.fromNullable(
              teams.find((t) => t.id === membership.teamId && t.contestId === contestId)
            )
          }),
        create: (t) => Ref.update(teamsRef, (teams) => [...teams, t]),
        setMembers: (contestId, teamId, userIds) =>
          Effect.gen(function* () {
            const membersBefore = yield* Ref.get(membersRef)
            const users = yield* Ref.get(usersRef)
            const existingInTarget = new Set(
              membersBefore
                .filter((m) => m.contestId === contestId && m.teamId === teamId)
                .map((m) => m.userId)
            )
            const incomingIds = new Set(userIds.filter((id) => !existingInTarget.has(id)))
            const conflicts = membersBefore
              .filter(
                (m) => m.contestId === contestId && m.teamId !== teamId && incomingIds.has(m.userId)
              )
              .map((m) => users.find((u) => u.id === m.userId)?.githubLogin)
              .filter((login): login is string => login !== undefined)
            if (conflicts.length > 0) {
              return yield* Effect.fail(new MemberConflict({ logins: conflicts }))
            }
            yield* Ref.update(membersRef, (members) => [
              ...members.filter((m) => !(m.contestId === contestId && m.teamId === teamId)),
              ...userIds.map((userId) => ({ contestId, teamId, userId }))
            ])
          }),
        addMember: (contestId, teamId, userId) =>
          Ref.modify(membersRef, (members): readonly [boolean, ReadonlyArray<ScopedMember>] => {
            if (members.some((m) => m.contestId === contestId && m.userId === userId)) {
              return [false, members]
            }
            return [true, [...members, { contestId, teamId, userId }]]
          }),
        listMembers: (contestId, teamId) =>
          Effect.gen(function* () {
            const members = yield* Ref.get(membersRef)
            const users = yield* Ref.get(usersRef)
            const memberIds = new Set(
              members
                .filter((m) => m.contestId === contestId && m.teamId === teamId)
                .map((m) => m.userId)
            )
            return users.filter((u) => memberIds.has(u.id))
          }),
        copyRoster: ({ targetContestId, teams: newTeams, memberships, invites: newInvites }) =>
          Effect.gen(function* () {
            yield* Ref.update(teamsRef, (existing) => [...existing, ...newTeams])
            yield* Ref.update(membersRef, (existing) => [
              ...existing,
              ...memberships.map((m) => ({ contestId: targetContestId, teamId: m.teamId, userId: m.userId }))
            ])
            yield* Ref.update(invitesRef, (existing) => [...existing, ...newInvites])
          })
      }

      const inviteRepo: Context.Tag.Service<InviteRepo> = {
        create: (invite) =>
          Ref.update(invitesRef, (invites) => [
            ...invites.filter(
              (i) => !(i.contestId === invite.contestId && i.githubLogin === invite.githubLogin)
            ),
            invite
          ]),
        findByGithubLogin: (contestId, githubLogin) =>
          Ref.get(invitesRef).pipe(
            Effect.map((invites) =>
              Option.fromNullable(
                invites.find((i) => i.contestId === contestId && i.githubLogin === githubLogin)
              )
            )
          ),
        delete: (contestId, githubLogin) =>
          Ref.update(invitesRef, (invites) =>
            invites.filter((i) => !(i.contestId === contestId && i.githubLogin === githubLogin))
          ),
        listByTeam: (contestId, teamId) =>
          Ref.get(invitesRef).pipe(
            Effect.map((invites) => invites.filter((i) => i.contestId === contestId && i.teamId === teamId))
          ),
        listByContest: (contestId) =>
          Ref.get(invitesRef).pipe(
            Effect.map((invites) =>
              invites.filter((i) => i.contestId === contestId).slice().sort((a, b) => a.invitedAt - b.invitedAt)
            )
          ),
        // live 判定は contests ストアと突き合わせる。contests パラメータを渡さ
        // なければ全 invite が live 扱い(既存 auth テストの多くは live のみで検証)。
        // invited_at ASC でソートするのは SQL 側と同一契約(auth 側 for-of の
        // 「ループ末尾の email が users.email を上書き」を決定論にする)。
        listByGithubLoginForLiveContests: (githubLogin) =>
          Effect.gen(function* () {
            const invites = yield* Ref.get(invitesRef)
            const contests = yield* Ref.get(contestsRef)
            const liveIds = new Set(
              contests
                .filter((c) => c.status === "draft" || c.status === "preparing" || c.status === "running" || c.status === "finalizing")
                .map((c) => c.id)
            )
            return invites
              .filter((i) => i.githubLogin === githubLogin && (contests.length === 0 || liveIds.has(i.contestId)))
              .slice()
              .sort((a, b) => a.invitedAt - b.invitedAt)
          })
      }

      return Context.make(UserRepo, userRepo).pipe(
        Context.add(SessionRepo, sessionRepo),
        Context.add(TeamRepo, teamRepo),
        Context.add(InviteRepo, inviteRepo)
      )
    })
  )

// InstanceRepo(contest スコープ)。create/createIfAllowed の重複判定は
// (contestId, teamId, index) で行う(migration 0005 の部分ユニーク index と同条件)。
export const makeInstanceRepoTest = (initial: ReadonlyArray<Instance> = []): Layer.Layer<InstanceRepo> =>
  Layer.effect(
    InstanceRepo,
    Effect.gen(function* () {
      const instancesRef = yield* Ref.make(initial)
      return {
        listByTeam: (contestId: ContestId, teamId: TeamId) =>
          Ref.get(instancesRef).pipe(
            Effect.map((instances) =>
              instances
                .filter((i) => i.contestId === contestId && i.teamId === teamId)
                .sort((a, b) => a.index - b.index)
            )
          ),
        // Task 8: readiness の previous_cleanup / beginContestPreparation 前検査。
        listByContest: (contestId: ContestId) =>
          Ref.get(instancesRef).pipe(
            Effect.map((instances) =>
              instances.filter((i) => i.contestId === contestId).sort((a, b) => a.index - b.index)
            )
          ),
        hasTransitional: Ref.get(instancesRef).pipe(
          Effect.map((instances) => instances.some((i) => i.status === "creating" || i.status === "deleting"))
        ),
        findById: (id: InstanceId) =>
          Ref.get(instancesRef).pipe(
            Effect.map((instances) => Option.fromNullable(instances.find((i) => i.id === id)))
          ),
        create: (i: Instance) =>
          Ref.modify(
            instancesRef,
            (instances): readonly [Either.Either<Instance, DuplicateInstanceIndex>, ReadonlyArray<Instance>] => {
              const duplicate = instances.some(
                (x) => x.contestId === i.contestId && x.teamId === i.teamId && x.index === i.index
              )
              if (duplicate) {
                return [Either.left(new DuplicateInstanceIndex({ teamId: i.teamId, index: i.index })), instances]
              }
              // 0005 の idx_instances_vmid_active と同じく、非 deleted の
              // vmid はエディション跨いで一意。SQL 側の SqlError→500 を避け
              // るため in-memory でも同じセマンティクスで DuplicateInstanceIndex
              // に落とす(handler で 409 として通す)。
              const vmidClash = instances.some((x) => x.vmid === i.vmid && x.status !== "deleted")
              if (vmidClash) {
                return [Either.left(new DuplicateInstanceIndex({ teamId: i.teamId, index: i.index })), instances]
              }
              return [Either.right(i), [...instances, i]]
            }
          ).pipe(Effect.flatMap(Either.match({ onLeft: Effect.fail, onRight: Effect.succeed }))),
        remove: (id: InstanceId) => Ref.update(instancesRef, (instances) => instances.filter((i) => i.id !== id)),
        createIfAllowed: (
          i: Instance,
          quota: number
        ): Effect.Effect<Instance, QuotaExceeded | ProvisionInProgress | DuplicateInstanceIndex> =>
          Ref.modify(
            instancesRef,
            (
              instances
            ): readonly [
              Either.Either<Instance, QuotaExceeded | ProvisionInProgress | DuplicateInstanceIndex>,
              ReadonlyArray<Instance>
            ] => {
              const activeCount = instances.filter(
                (x) =>
                  x.contestId === i.contestId &&
                  x.teamId === i.teamId &&
                  (x.status === "creating" || x.status === "running")
              ).length
              if (activeCount >= quota) {
                return [Either.left(new QuotaExceeded({ teamId: i.teamId, quota })), instances]
              }
              const inProgress = instances.some(
                (x) =>
                  x.contestId === i.contestId &&
                  x.teamId === i.teamId &&
                  (x.status === "creating" || x.status === "deleting")
              )
              if (inProgress) {
                return [Either.left(new ProvisionInProgress({ teamId: i.teamId })), instances]
              }
              const duplicate = instances.some(
                (x) =>
                  x.contestId === i.contestId &&
                  x.teamId === i.teamId &&
                  x.index === i.index &&
                  x.status !== "deleted"
              )
              if (duplicate) {
                return [Either.left(new DuplicateInstanceIndex({ teamId: i.teamId, index: i.index })), instances]
              }
              const vmidClash = instances.some((x) => x.vmid === i.vmid && x.status !== "deleted")
              if (vmidClash) {
                return [Either.left(new DuplicateInstanceIndex({ teamId: i.teamId, index: i.index })), instances]
              }
              return [Either.right(i), [...instances, i]]
            }
          ).pipe(Effect.flatMap(Either.match({ onLeft: Effect.fail, onRight: Effect.succeed }))),
        beginDeletingIfAllowed: (instanceId: InstanceId, now: number) =>
          Ref.modify(instancesRef, (instances): readonly [Option.Option<Instance>, ReadonlyArray<Instance>] => {
            const target = instances.find((x) => x.id === instanceId)
            if (target === undefined || (target.status !== "running" && target.status !== "failed")) {
              return [Option.none(), instances]
            }
            const otherInProgress = instances.some(
              (x) =>
                x.contestId === target.contestId &&
                x.teamId === target.teamId &&
                x.id !== instanceId &&
                (x.status === "creating" || x.status === "deleting")
            )
            if (otherInProgress) return [Option.none(), instances]
            const updated = new Instance({ ...target, status: "deleting", updatedAt: now })
            return [Option.some(updated), instances.map((x) => (x.id === instanceId ? updated : x))]
          }),
        update: (i: Instance) =>
          Ref.update(instancesRef, (instances) => instances.map((x) => (x.id === i.id ? i : x))),
        findNextForOrchestration: Ref.get(instancesRef).pipe(
          Effect.map((instances) => {
            const candidates = instances
              .filter((i) => i.status === "creating" || i.status === "deleting")
              .sort((a, b) => a.createdAt - b.createdAt)
            return Option.fromNullable(candidates[0])
          })
        )
      }
    })
  )

export const makeBenchJobRepoTest = (
  initial: ReadonlyArray<BenchJob> = [],
  options: {
    scoreboardTeams?: ReadonlyArray<Team>
  } = {}
): Layer.Layer<BenchJobRepo> =>
  Layer.effect(
    BenchJobRepo,
    Effect.gen(function* () {
      const jobsRef = yield* Ref.make(initial)
      const logsRef = yield* Ref.make<Record<string, string>>({})

      const atomicTransition = <E>(
        id: BenchJobId,
        actionName: string,
        transition: (job: BenchJob) => Either.Either<BenchJob, E>
      ): Effect.Effect<BenchJob, E> =>
        Ref.modify(
          jobsRef,
          (jobs): readonly [Option.Option<Either.Either<BenchJob, E>>, ReadonlyArray<BenchJob>] => {
            const job = jobs.find((j) => j.id === id)
            if (job === undefined) return [Option.none(), jobs]
            return Either.match(transition(job), {
              onLeft: (e) => [Option.some(Either.left(e)), jobs],
              onRight: (updated) => [
                Option.some(Either.right(updated)),
                jobs.map((j) => (j.id === id ? updated : j))
              ]
            })
          }
        ).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.dieMessage(`${actionName}: BenchJob ${id} not found`),
              onSome: Either.match({ onLeft: Effect.fail, onRight: Effect.succeed })
            })
          )
        )

      return {
        insertIfAllowed: (job: BenchJob) =>
          Ref.modify(
            jobsRef,
            (jobs): readonly [Either.Either<BenchJob, TeamJobAlreadyQueued>, ReadonlyArray<BenchJob>] => {
              const hasActiveForTeam = jobs.some(
                (j) =>
                  j.contestId === job.contestId &&
                  j.teamId === job.teamId &&
                  j.purpose === job.purpose &&
                  (j.status === "queued" || j.status === "running")
              )
              if (hasActiveForTeam) {
                return [Either.left(new TeamJobAlreadyQueued({ teamId: job.teamId })), jobs]
              }
              return [Either.right(job), [...jobs, job]]
            }
          ).pipe(Effect.flatMap(Either.match({ onLeft: Effect.fail, onRight: Effect.succeed }))),
        findById: (id: BenchJobId) =>
          Ref.get(jobsRef).pipe(Effect.map((jobs) => Option.fromNullable(jobs.find((j) => j.id === id)))),
        listByTeam: (contestId: ContestId, teamId: TeamId, limit: number) =>
          Ref.get(jobsRef).pipe(
            Effect.map((jobs) =>
              jobs
                .filter((j) => j.contestId === contestId && j.teamId === teamId)
                .sort((a, b) => b.enqueuedAt - a.enqueuedAt)
                .slice(0, limit)
            )
          ),
        dequeueNextQueued: (
          candidate: { contestId: ContestId; purpose: BenchJobPurpose },
          now: number
        ) =>
          Ref.modify(
            jobsRef,
            (jobs): readonly [Option.Option<BenchJob>, ReadonlyArray<BenchJob>] => {
              const purposeRunning = jobs.some(
                (j) =>
                  j.status === "running" &&
                  j.contestId === candidate.contestId &&
                  j.purpose === candidate.purpose
              )
              if (purposeRunning) return [Option.none(), jobs]
              const queued = jobs
                .filter(
                  (j) =>
                    j.status === "queued" &&
                    j.contestId === candidate.contestId &&
                    j.purpose === candidate.purpose
                )
                .sort((a, b) => a.enqueuedAt - b.enqueuedAt)
              const next = queued[0]
              if (next === undefined) return [Option.none(), jobs]
              const started = Either.getOrThrow(startJob(next, now))
              const updated = jobs.map((j) => (j.id === started.id ? started : j))
              return [Option.some(started), updated]
            }
          ),
        recordProgressIfRunning: (id: BenchJobId, now: number) =>
          atomicTransition(id, "recordProgressIfRunning", (job) => recordProgress(job, now)),
        finishIfRunning: (id: BenchJobId, result: { score: number; passed: boolean }, now: number) =>
          atomicTransition(id, "finishIfRunning", (job) => finishJob(job, result, now)),
        failIfRunning: (id: BenchJobId, errorMessage: string, now: number) =>
          atomicTransition(id, "failIfRunning", (job) => failJob(job, errorMessage, now)),
        cancelIfQueued: (id: BenchJobId) =>
          atomicTransition<CannotCancelRunning | InvalidJobTransition>(id, "cancelIfQueued", (job) => cancelJob(job)),
        cancelQueuedRehearsalsForContest: (contestId: ContestId) =>
          Ref.update(jobsRef, (jobs) =>
            jobs.map((j) =>
              j.contestId === contestId && j.status === "queued" && j.purpose === "rehearsal"
                ? new BenchJob({ ...j, status: "canceled" })
                : j
            )
          ),
        // Task 11: purpose を分けず contest スコープの queued を全て canceled に。
        cancelQueuedByContest: (contestId: ContestId, now: number) =>
          Ref.modify(jobsRef, (jobs): readonly [number, ReadonlyArray<BenchJob>] => {
            let count = 0
            const updated = jobs.map((j) => {
              if (j.contestId === contestId && j.status === "queued") {
                count++
                return new BenchJob({ ...j, status: "canceled", finishedAt: Option.some(now) })
              }
              return j
            })
            return [count, updated]
          }),
        countRunningByContest: (contestId: ContestId) =>
          Ref.get(jobsRef).pipe(
            Effect.map((jobs) => jobs.filter((j) => j.contestId === contestId && j.status === "running").length)
          ),
        appendLog: (id: BenchJobId, chunk: string) =>
          Ref.update(logsRef, (logs) => ({ ...logs, [id]: (logs[id] ?? "") + chunk })),
        getLog: (id: BenchJobId) => Ref.get(logsRef).pipe(Effect.map((logs) => logs[id] ?? "")),
        failTimedOutJobs: (cutoff: number, now: number) =>
          Ref.modify(jobsRef, (jobs): readonly [number, ReadonlyArray<BenchJob>] => {
            let count = 0
            const updated = jobs.map((j) => {
              const isStale =
                j.status === "running" &&
                Option.match(j.lastProgressAt, { onNone: () => false, onSome: (t) => t < cutoff })
              if (!isStale) return j
              count++
              return Either.getOrThrow(failJob(j, "timeout", now))
            })
            return [count, updated]
          }),
        // scoreboard: 集計対象は contestId + purpose='competition' の finished。
        // options.scoreboardTeams が渡されていれば teams JOIN 済み結果を返し、
        // 未指定なら空配列(集計はテスト対象外)。
        scoreboard: (contestId: ContestId) =>
          Effect.gen(function* () {
            const teams = options.scoreboardTeams ?? []
            const scopedTeams = teams.filter((t) => t.contestId === contestId)
            if (scopedTeams.length === 0) return []
            const jobs = yield* Ref.get(jobsRef)
            return scopedTeams
              .sort((a, b) => a.teamNumber - b.teamNumber)
              .map((t) => {
                const finished = jobs
                  .filter(
                    (j) =>
                      j.contestId === contestId &&
                      j.teamId === t.id &&
                      j.status === "finished" &&
                      j.purpose === "competition"
                  )
                  .sort((a, b) => {
                    const bAt = Option.getOrElse(b.finishedAt, () => 0) - Option.getOrElse(a.finishedAt, () => 0)
                    return bAt !== 0 ? bAt : (a.id < b.id ? 1 : -1)
                  })
                const scores = finished.flatMap((j) =>
                  Option.match(j.score, { onNone: () => [] as number[], onSome: (s) => [s] })
                )
                const bestScore = scores.length > 0 ? Math.max(...scores) : null
                const latest = finished[0]
                return {
                  teamId: t.id,
                  teamName: t.name,
                  bestScore,
                  latestScore: latest === undefined ? null : Option.getOrNull(latest.score),
                  latestAt: latest === undefined ? null : Option.getOrNull(latest.finishedAt)
                }
              })
          }),
        // Task 10: 「passed=1 かつ purpose='rehearsal' かつ finished」件数を数える。
        countSuccessfulRehearsals: (contestId: ContestId) =>
          Ref.get(jobsRef).pipe(
            Effect.map(
              (jobs) =>
                jobs.filter(
                  (j) =>
                    j.contestId === contestId &&
                    j.purpose === "rehearsal" &&
                    j.status === "finished" &&
                    Option.match(j.passed, { onNone: () => false, onSome: (p) => p })
                ).length
            )
          )
      }
    })
  )


// Task 10 で maxAgeMillis が RunnerConfig に加わった。既定は 60_000ms
// (readiness の runner check で使う。個別テストは短い値に上書きして stale
// テストケースを作る)。
export const RunnerConfigTest = (
  jobTimeoutMillis: number,
  maxAgeMillis: number = 60_000
): Layer.Layer<RunnerConfig> => Layer.succeed(RunnerConfig, { jobTimeoutMillis, maxAgeMillis })

// 払い出しガードの閾値・タイムアウト(Task 4)。既定は本番既定と同じ
// 5GiB(minFreeMemBytes)/ 120 秒(guestAgentTimeoutMillis)。テストで
// RAM 不足分岐を作るときは minFreeMemBytes を大きくして freeMemBytes を
// 下回らせる(あるいは makeProxmoxPortTest の freeMemBytes を小さくする)。
export const ProvisioningConfigTest = (
  overrides: { minFreeMemBytes?: number; guestAgentTimeoutMillis?: number } = {}
): Layer.Layer<ProvisioningConfig> =>
  Layer.succeed(ProvisioningConfig, {
    minFreeMemBytes: overrides.minFreeMemBytes ?? 5_000_000_000,
    guestAgentTimeoutMillis: overrides.guestAgentTimeoutMillis ?? 120_000
  })

// UserRepo と SessionRepo のインメモリ実装。findValidUser が users と sessions
// を JOIN する(本番 SQL 実装と同じ意味論)ため、両者で状態を共有する必要が
// あり、1 つの Layer で両タグをまとめて提供する。
export const makeAuthReposTest = (): Layer.Layer<UserRepo | SessionRepo> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const usersRef = yield* Ref.make<ReadonlyArray<User>>([])
      const sessionsRef = yield* Ref.make<
        ReadonlyArray<{ sessionId: string; userId: UserId; expiresAt: number }>
      >([])
      const counter = yield* Ref.make(0)

      const userRepo: Context.Tag.Service<UserRepo> = {
        upsertByGithub: (u) =>
          Effect.gen(function* () {
            const n = yield* Ref.updateAndGet(counter, (c) => c + 1)
            return yield* Ref.modify(usersRef, (users): readonly [User, ReadonlyArray<User>] => {
              const existing = users.find((x) => x.githubId === u.githubId)
              if (existing !== undefined) {
                const updated = new User({
                  ...existing,
                  githubLogin: u.githubLogin,
                  displayName: u.displayName,
                  isAdmin: u.isAdmin
                })
                return [updated, users.map((x) => (x.githubId === u.githubId ? updated : x))]
              }
              const created = new User({
                id: UserId.make(`test-user-${n}`),
                githubId: u.githubId,
                githubLogin: u.githubLogin,
                displayName: u.displayName,
                isAdmin: u.isAdmin,
                email: Option.none()
              })
              return [created, [...users, created]]
            })
          }),
        findById: (id) =>
          Ref.get(usersRef).pipe(Effect.map((users) => Option.fromNullable(users.find((u) => u.id === id)))),
        findManyByGithubLogins: (logins) =>
          Ref.get(usersRef).pipe(Effect.map((users) => users.filter((u) => logins.includes(u.githubLogin)))),
        setEmail: (id, email) =>
          Ref.update(usersRef, (users) =>
            users.map((u) => (u.id === id ? new User({ ...u, email: Option.some(email) }) : u))
          )
      }

      const sessionRepo: Context.Tag.Service<SessionRepo> = {
        create: (userId, expiresAt) =>
          Effect.gen(function* () {
            const n = yield* Ref.updateAndGet(counter, (c) => c + 1)
            const sessionId = `test-session-${n}`
            yield* Ref.update(sessionsRef, (sessions) => [...sessions, { sessionId, userId, expiresAt }])
            return sessionId
          }),
        findValidUser: (sessionId, now) =>
          Effect.gen(function* () {
            const sessions = yield* Ref.get(sessionsRef)
            const session = sessions.find((s) => s.sessionId === sessionId && s.expiresAt > now)
            if (session === undefined) return Option.none<User>()
            const users = yield* Ref.get(usersRef)
            return Option.fromNullable(users.find((u) => u.id === session.userId))
          }),
        delete: (sessionId) =>
          Ref.update(sessionsRef, (sessions) => sessions.filter((s) => s.sessionId !== sessionId))
      }

      return Context.make(UserRepo, userRepo).pipe(Context.add(SessionRepo, sessionRepo))
    })
  )

// Phase 3(Task 3)の 3 port のインメモリ実装。Task 4 の払い出し/撤収 saga・
// 招待フローのテストで、実 HTTP なしにオーケストレーションの分岐(冪等性・
// 補償処理・失敗時のロールバック)を検証するために使う。
//
// 各 make*Test は `{ layer, getState }` を返す(ports.ts の 3 port には
// リポジトリのような読み取り専用メソッドが無いため、呼び出し履歴・結果状態を
// テストから検証する手段として getState という Effect を追加で提供する。他の
// インメモリ実装(Layer のみを返す)とはこの点で異なる)。

export type ProxmoxOperation =
  | "cloneVm"
  | "configureCloudInit"
  | "setVnet"
  | "startVm"
  | "stopAndDestroyVm"
  | "waitForGuestAgent"
  | "guestExec"
  | "getNodeFreeMemBytes"
  | "vmExists"
  | "listManagedVms"
  | "getInfrastructureInventory"
  | "setVmOnBoot"
  | "shutdownVm"
  | "waitForVmStatus"

export interface ProxmoxTestState {
  readonly clonedVmids: ReadonlyArray<number>
  readonly configuredVmids: ReadonlyArray<number>
  readonly vnetByVmid: Readonly<Record<number, string>>
  readonly startedVmids: ReadonlyArray<number>
  readonly destroyedVmids: ReadonlyArray<number>
  readonly authorizedKeysByVmid: Readonly<Record<number, ReadonlyArray<string>>>
  readonly guestExecCalls: ReadonlyArray<{ vmid: number; command: ReadonlyArray<string> }>
  // vmExists の判定元(Task 4 レビュー C1)。cloneVm で追加、stopAndDestroyVm で
  // 除去する(実 Proxmox の「clone すれば存在し、destroy すれば消える」を模す)。
  // 初期値は options.existingVmids で「クラッシュ前に clone だけ成功し
  // progress 未保存のまま再開する」ケースを直接シードできる。
  readonly existingVmids: ReadonlyArray<number>
  // Task 8: enter_contest_mode の観測。テストは shutdown/onboot 設定 /
  // inventory 再観測が期待順序で発生することを検証する。
  readonly shutdownRequests: ReadonlyArray<number>
  readonly forceStopRequests: ReadonlyArray<number>
  readonly onBootByVmid: Readonly<Record<number, boolean>>
  readonly inventoryReads: number
}

const emptyProxmoxState: ProxmoxTestState = {
  clonedVmids: [],
  configuredVmids: [],
  vnetByVmid: {},
  startedVmids: [],
  destroyedVmids: [],
  authorizedKeysByVmid: {},
  guestExecCalls: [],
  existingVmids: [],
  shutdownRequests: [],
  forceStopRequests: [],
  onBootByVmid: {},
  inventoryReads: 0
}

// authorized_keys への追記を模す固定コマンド(実装は
// src/infrastructure/proxmox/client.ts の guestExec 呼び出し元 — Task 4/5 —
// が組み立てる想定の printf 形 `printf "%s\n" "<key>"` と同じ検出ロジック)。
// フォーマット(printf の直後が "%s\n"、その次が鍵)と配列長を確認してから
// 抽出し、printf を使う別コマンドを誤検出しない。
const extractAppendedKey = (command: ReadonlyArray<string>): string | undefined => {
  const idx = command.findIndex((c) => c === "printf")
  if (idx === -1) return undefined
  // argv 上の printf フォーマット文字列(バックスラッシュ + n の 4 文字 "%s\n")。
  if (command[idx + 1] !== "%s\\n") return undefined
  if (idx + 2 >= command.length) return undefined
  return command[idx + 2]
}

// options.failWith: 特定の操作を常に指定エラーで失敗させる(saga の補償処理・
// エラーハンドリングをテストするためのフック)。waitForGuestAgent だけ
// ProvisionTimeout も許容する(ports.ts のシグネチャに合わせる)。
// Task 8: waitForVmStatus / shutdownVm も型付きエラーを許容する。前者は
// ModeTransitionTimeout を、後者は ProxmoxError のみを受ける。
type ProxmoxFailWith = Partial<Record<Exclude<ProxmoxOperation, "waitForGuestAgent" | "waitForVmStatus">, ProxmoxError>> & {
  waitForGuestAgent?: ProxmoxError | ProvisionTimeout
  waitForVmStatus?: ProxmoxError | ModeTransitionTimeout
}

// Task 7: reconciliation の inventory 用に managedVms を直接シードできる。
// listManagedVms は既定 [] を返す(既存テストは inventory を読まないため互換)。
export interface ManagedVmSeed {
  readonly vmid: number
  readonly name: string
  readonly status: "running" | "stopped"
  readonly memoryBytes?: number
}

// Task 8: makeProxmoxPortTest の options を named type として export し、
// テスト側から重複定義せず再利用できるようにする(ts-no-return-type ルール)。
export interface ProxmoxTestOptions {
  freeMemBytes?: number
  guestAgentReady?: boolean
  failWith?: ProxmoxFailWith
  existingVmids?: ReadonlyArray<number>
  managedVms?: ReadonlyArray<ManagedVmSeed>
  // Task 8: getInfrastructureInventory の返却値を直接シードする。未指定なら
  // 呼び出しは defect にせず、テスト用に「最低限あり得る値(template/devvm/
  // benchvm 全部あり、preparedTeamNumbers=[1,2]、isolation active、free 6 GiB)」
  // を返す(既存テストで新メソッドを触るところは無いはずだが安全側)。
  infrastructureInventory?: ProxmoxInfrastructureInventory
}

export interface ProxmoxPortTestFixture {
  readonly layer: Layer.Layer<ProxmoxPort>
  readonly getState: Effect.Effect<ProxmoxTestState>
}

export const makeProxmoxPortTest = (
  options: ProxmoxTestOptions = {}
): ProxmoxPortTestFixture => {
  const DEFAULT_INVENTORY: ProxmoxInfrastructureInventory = {
    nodeFreeMemBytes: 20_000_000_000,
    templateExists: true,
    devvm: {
      vmid: 9300,
      name: "devvm",
      status: "running",
      memoryBytes: 8 * 1024 * 1024 * 1024,
      onBoot: true
    },
    benchvm: {
      vmid: 9200,
      name: "benchvm",
      status: "stopped",
      memoryBytes: 4 * 1024 * 1024 * 1024,
      onBoot: false
    },
    preparedTeamNumbers: [1, 2],
    isolationServiceActive: true
  }
  const inventory = options.infrastructureInventory ?? DEFAULT_INVENTORY
  const stateRef = Ref.unsafeMake({ ...emptyProxmoxState, existingVmids: options.existingVmids ?? [] })
  const freeMemBytes = options.freeMemBytes ?? 6_000_000_000
  const guestAgentReady = options.guestAgentReady ?? true

  const guarded = <A>(
    op: Exclude<ProxmoxOperation, "waitForGuestAgent" | "waitForVmStatus">,
    succeed: Effect.Effect<A, never>
  ): Effect.Effect<A, ProxmoxError> => {
    const failure = options.failWith?.[op]
    return failure !== undefined ? Effect.fail(failure) : succeed
  }

  const layer = Layer.succeed(ProxmoxPort, {
    cloneVm: ({ newVmid }) =>
      guarded(
        "cloneVm",
        Ref.update(stateRef, (s) => ({
          ...s,
          clonedVmids: [...s.clonedVmids, newVmid],
          existingVmids: s.existingVmids.includes(newVmid) ? s.existingVmids : [...s.existingVmids, newVmid]
        }))
      ),
    configureCloudInit: ({ vmid }) =>
      guarded(
        "configureCloudInit",
        Ref.update(stateRef, (s) => ({ ...s, configuredVmids: [...s.configuredVmids, vmid] }))
      ),
    setVnet: ({ bridge, vmid }) =>
      guarded(
        "setVnet",
        Ref.update(stateRef, (s) => ({ ...s, vnetByVmid: { ...s.vnetByVmid, [vmid]: bridge } }))
      ),
    startVm: (vmid) =>
      guarded(
        "startVm",
        Ref.update(stateRef, (s) => ({ ...s, startedVmids: [...s.startedVmids, vmid] }))
      ),
    // 冪等: 何度呼んでも destroyedVmids に重複追加しない。existingVmids から
    // 除去することで、以後の vmExists(vmid) は false を返すようになる。
    stopAndDestroyVm: (vmid) =>
      guarded(
        "stopAndDestroyVm",
        Ref.update(stateRef, (s) => ({
          ...s,
          destroyedVmids: s.destroyedVmids.includes(vmid) ? s.destroyedVmids : [...s.destroyedVmids, vmid],
          existingVmids: s.existingVmids.filter((v) => v !== vmid)
        }))
      ),
    waitForGuestAgent: (vmid, timeoutMillis) => {
      const failure = options.failWith?.waitForGuestAgent
      if (failure !== undefined) return Effect.fail(failure)
      return guestAgentReady ? Effect.void : Effect.fail(new ProvisionTimeout({ vmid, timeoutMillis }))
    },
    // authorized_keys 追記コマンド(printf "%s\n" "<key>" >> ...)を検出して
    // 重複無しで追記する。それ以外のコマンドは記録だけして成功を返す。
    guestExec: ({ command, vmid }) =>
      guarded(
        "guestExec",
        Ref.modify(stateRef, (s): readonly [{ exitcode: number; out: string }, ProxmoxTestState] => {
          const key = extractAppendedKey(command)
          const currentKeys = s.authorizedKeysByVmid[vmid] ?? []
          const updatedKeys = key === undefined || currentKeys.includes(key) ? currentKeys : [...currentKeys, key]
          const nextState: ProxmoxTestState = {
            ...s,
            authorizedKeysByVmid: { ...s.authorizedKeysByVmid, [vmid]: updatedKeys },
            guestExecCalls: [...s.guestExecCalls, { vmid, command }]
          }
          return [{ exitcode: 0, out: `${updatedKeys.length} authorized_keys\n` }, nextState]
        })
      ),
    getNodeFreeMemBytes: guarded("getNodeFreeMemBytes", Effect.succeed(freeMemBytes)),
    vmExists: (vmid) =>
      guarded(
        "vmExists",
        Ref.get(stateRef).pipe(Effect.map((s) => s.existingVmids.includes(vmid)))
      ),
    listManagedVms: guarded(
      "listManagedVms",
      Effect.succeed(
        (options.managedVms ?? []).map((v) => ({
          vmid: v.vmid,
          name: v.name,
          status: v.status,
          memoryBytes: v.memoryBytes ?? 4 * 1024 * 1024 * 1024
        }))
      )
    ),
    getInfrastructureInventory: guarded(
      "getInfrastructureInventory",
      Ref.update(stateRef, (s) => ({ ...s, inventoryReads: s.inventoryReads + 1 })).pipe(
        Effect.andThen(Effect.succeed(inventory))
      )
    ),
    setVmOnBoot: (vmid, enabled) =>
      guarded(
        "setVmOnBoot",
        Ref.update(stateRef, (s) => ({ ...s, onBootByVmid: { ...s.onBootByVmid, [vmid]: enabled } }))
      ),
    shutdownVm: (vmid) =>
      guarded(
        "shutdownVm",
        Ref.update(stateRef, (s) => ({ ...s, shutdownRequests: [...s.shutdownRequests, vmid] }))
      ),
    waitForVmStatus: (vmid, expected, timeoutMillis) => {
      const failure = options.failWith?.waitForVmStatus
      if (failure !== undefined) return Effect.fail(failure)
      // 既定は inventory の状態と一致するかで判定する。inventory と一致しない
      // (= shutdown/start がまだ)なら ModeTransitionTimeout(テスト側で
      // shutdown/start の記録を進めれば inventory を上書きして pass にできる)。
      const inv = inventory
      const actual = vmid === inv.devvm.vmid ? inv.devvm.status : vmid === inv.benchvm.vmid ? inv.benchvm.status : "stopped"
      return actual === expected
        ? Effect.void
        : Effect.fail(new ModeTransitionTimeout({ vmid, expected, timeoutMillis }))
    }
  })

  return { layer, getState: Ref.get(stateRef) }
}

export interface CloudflareTestState {
  readonly routesByHostname: Readonly<Record<string, string>>
  readonly accessEmailsByHostname: Readonly<Record<string, ReadonlyArray<string>>>
  // Task 9: 「exact set で書き込まれた回数」= 呼び出し履歴を軽量に検証するため。
  // (batch prepare のテストが「1 台ずつ」書き換わることをアサートする。)
  readonly ensureAccessAppExactCallsByHostname: Readonly<Record<string, number>>
  // Task 9: portal 側で持つ「app_id / policy_id / dns_record_id」を確定させる
  // ため、テスト port も deterministic な ID を返せるようにする。
  readonly dnsRecordIdByHostname: Readonly<Record<string, string>>
  readonly accessAppIdByHostname: Readonly<Record<string, string>>
  readonly accessPolicyIdByHostname: Readonly<Record<string, string | null>>
}

const emptyCloudflareState: CloudflareTestState = {
  routesByHostname: {},
  accessEmailsByHostname: {},
  ensureAccessAppExactCallsByHostname: {},
  dnsRecordIdByHostname: {},
  accessAppIdByHostname: {},
  accessPolicyIdByHostname: {}
}

export type CloudflareOperation =
  | "ensureInstanceRoute"
  | "removeInstanceRoute"
  | "ensureAccessAppExact"
  | "removeAccessApp"
  | "getInstanceInventory"
  | "probe"

// Task 7: reconciliation inventory を直接シードするためのオプション。
// 既定 { routes: [], apps: [] }(既存テストは inventory を読まない)。
export interface CloudflareInventorySeed {
  readonly routes: ReadonlyArray<{
    readonly hostname: string
    readonly dnsRecordIds: ReadonlyArray<string>
    readonly ingressServices: ReadonlyArray<string>
  }>
  readonly apps: ReadonlyArray<{
    readonly hostname: string
    readonly appIds: ReadonlyArray<string>
    readonly policyShape: "owned_exact" | "unknown"
    readonly emailSetHash: string
  }>
}

// Task 8: named options / fixture types(ts-no-return-type ルール準拠、
// テスト側から重複定義せず再利用できるようにする)。
export interface CloudflareTestOptions {
  failWith?: Partial<Record<CloudflareOperation, CloudflareError>>
  inventory?: CloudflareInventorySeed
  // Task 9: `ensureAccessAppExact` を AmbiguousAccessPolicy で失敗させる注入。
  // failWith と別にする理由は AmbiguousAccessPolicy が CloudflareError の
  // union の外側にあるため(呼び出し元 err channel が分けて扱う)。
  ambiguousAccessPolicyFor?: ReadonlyArray<{
    readonly hostname: string
    readonly reason: "multiple_allow_policies" | "non_email_include_present" | "policy_shape_unknown"
  }>
}

export interface CloudflarePortTestFixture {
  readonly layer: Layer.Layer<CloudflarePort>
  readonly getState: Effect.Effect<CloudflareTestState>
}

export const makeCloudflarePortTest = (
  options: CloudflareTestOptions = {}
): CloudflarePortTestFixture => {
  const stateRef = Ref.unsafeMake(emptyCloudflareState)
  const ambiguousByHostname: Record<
    string,
    "multiple_allow_policies" | "non_email_include_present" | "policy_shape_unknown"
  > = {}
  for (const entry of options.ambiguousAccessPolicyFor ?? []) {
    ambiguousByHostname[entry.hostname] = entry.reason
  }
  // Task 9: exact set semantics 準拠のスタブでも、Live と同じ「trim +
  // lowercase + dedupe + sort」の正規化を通す — テストが「port レベルで
  // 正規化されている」ことを observe できるようにする。
  const normalize = (emails: ReadonlyArray<string>): ReadonlyArray<string> =>
    Array.from(
      new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0))
    ).sort()

  const guarded = <A>(op: CloudflareOperation, succeed: Effect.Effect<A, never>): Effect.Effect<A, CloudflareError> => {
    const failure = options.failWith?.[op]
    return failure !== undefined ? Effect.fail(failure) : succeed
  }

  const layer = Layer.succeed(CloudflarePort, {
    ensureInstanceRoute: ({ hostname, ip }) =>
      guarded(
        "ensureInstanceRoute",
        Effect.gen(function* () {
          const dnsRecordId = `test-dns-${hostname}`
          yield* Ref.update(stateRef, (s) => ({
            ...s,
            routesByHostname: { ...s.routesByHostname, [hostname]: ip },
            dnsRecordIdByHostname: { ...s.dnsRecordIdByHostname, [hostname]: dnsRecordId }
          }))
          return { dnsRecordId }
        })
      ),
    removeInstanceRoute: (hostname) =>
      guarded(
        "removeInstanceRoute",
        Ref.update(stateRef, (s) => {
          const { [hostname]: _removed, ...rest } = s.routesByHostname
          const { [hostname]: _dropped, ...restDns } = s.dnsRecordIdByHostname
          return { ...s, routesByHostname: rest, dnsRecordIdByHostname: restDns }
        })
      ),
    // Task 9: exact set semantics(Phase 3 の「和集合」を置き換え)。ambiguous
    // 注入があればここで AmbiguousAccessPolicy を返し、それ以外は「渡された
    // 集合そのまま」で state を上書きする。call 数を hostname 単位に加算する。
    ensureAccessAppExact: ({ emails, hostname }) => {
      const failure = options.failWith?.ensureAccessAppExact
      if (failure !== undefined) return Effect.fail(failure)
      const ambiguousReason = ambiguousByHostname[hostname]
      if (ambiguousReason !== undefined) {
        return Effect.fail(new AmbiguousAccessPolicy({ hostname, reason: ambiguousReason }))
      }
      const normalized = normalize(emails)
      return Effect.gen(function* () {
        const appId = `test-app-${hostname}`
        const policyId = normalized.length === 0 ? null : `test-policy-${hostname}`
        yield* Ref.update(stateRef, (s) => {
          const nextCalls = { ...s.ensureAccessAppExactCallsByHostname }
          nextCalls[hostname] = (nextCalls[hostname] ?? 0) + 1
          return {
            ...s,
            accessEmailsByHostname: { ...s.accessEmailsByHostname, [hostname]: normalized },
            ensureAccessAppExactCallsByHostname: nextCalls,
            accessAppIdByHostname: { ...s.accessAppIdByHostname, [hostname]: appId },
            accessPolicyIdByHostname: { ...s.accessPolicyIdByHostname, [hostname]: policyId }
          }
        })
        return { appId, policyId }
      })
    },
    removeAccessApp: (hostname) =>
      guarded(
        "removeAccessApp",
        Ref.update(stateRef, (s) => {
          const { [hostname]: _removed, ...rest } = s.accessEmailsByHostname
          const { [hostname]: _appDropped, ...restApp } = s.accessAppIdByHostname
          const { [hostname]: _polDropped, ...restPol } = s.accessPolicyIdByHostname
          return {
            ...s,
            accessEmailsByHostname: rest,
            accessAppIdByHostname: restApp,
            accessPolicyIdByHostname: restPol
          }
        })
      ),
    getInstanceInventory: guarded(
      "getInstanceInventory",
      Effect.succeed(options.inventory ?? { routes: [], apps: [] })
    ),
    // Task 8: readiness の cloudflare_token key が呼ぶ probe。既定は成功。
    // round 1 finding 3: inventoryReadable フラグは廃止し、tokenStatus のみ。
    probe: guarded(
      "probe",
      Effect.succeed({ tokenStatus: "active" as const })
    )
  })

  return { layer, getState: Ref.get(stateRef) }
}

// login → 公開鍵一覧の対応表で GithubKeysPort をスタブする
// (test/support/githubOAuthStub.ts の makeGithubOAuthStub と同じ形)。
// 対応表にない login、または空配列が登録された login は GithubKeysError で失敗する
// (Live 実装の「空は GithubKeysError」と同じ意味論)。
export const makeGithubKeysPortTest = (
  byLogin: Record<string, ReadonlyArray<string>> = {}
): Layer.Layer<GithubKeysPort> =>
  Layer.succeed(GithubKeysPort, {
    fetchKeys: (login) => {
      const keys = byLogin[login]
      return keys !== undefined && keys.length > 0
        ? Effect.succeed(keys)
        : Effect.fail(new GithubKeysError({ cause: `no keys registered for ${login}` }))
    }
  })

// Task 6/7: ResourceBinding のインメモリ実装。upsert は
// (provider, resource_type, canonical_key) の 3-tuple を key に既存を差し替える。
// listByContest は contestId でフィルタする。
// Task 9: review round 1 finding 1 用に upsert 失敗を注入する option。
export const makeResourceBindingRepoTest = (
  initial: ReadonlyArray<ResourceBinding> = [],
  options: { readonly failWithUpsert?: RepoError } = {}
): Layer.Layer<ResourceBindingRepo> =>
  Layer.effect(
    ResourceBindingRepo,
    Effect.gen(function* () {
      const rowsRef = yield* Ref.make<ReadonlyArray<ResourceBinding>>(initial)
      return {
        upsert: (binding) => {
          if (options.failWithUpsert !== undefined) {
            return Effect.fail(options.failWithUpsert)
          }
          return Ref.update(rowsRef, (rows) => {
            const idx = rows.findIndex(
              (r) =>
                r.provider === binding.provider &&
                r.resourceType === binding.resourceType &&
                r.canonicalKey === binding.canonicalKey
            )
            if (idx < 0) return [...rows, binding]
            const next = rows.slice()
            next[idx] = binding
            return next
          })
        },
        listByContest: (contestId) =>
          Ref.get(rowsRef).pipe(Effect.map((rows) => rows.filter((r) => r.contestId === contestId))),
        deleteById: (id) => Ref.update(rowsRef, (rows) => rows.filter((r) => r.id !== id))
      }
    })
  )

// Task 6/7: OperationRepo のインメモリ実装。SQL 実装と同じ意味論を素直に再現する。
// - enqueue: 未完了 Operation(status ∉ succeeded/canceled)が 1 件でもあれば OperationInProgress。
//            0-step は defect(SQL 側と同じ契約)。
// - findById / listSteps は単純 lookup。claimNext / completeStep 等は Task 7 の
//   apply テストでは使わない(HTTP テスト側で SQL 実装が動く)ため未実装で defect。
//
// UuidGen をコンテキストから受け取る形にすると Layer グラフが複雑になるため、
// step id は Ref カウンタで局所発番する(id の一意性だけが必要で形式は不問)。
export const makeOperationRepoTest = (): { layer: Layer.Layer<OperationRepo>; get: (id: OperationId) => Effect.Effect<Option.Option<Operation>> } => {
  let seq = 0
  const nextId = () => `test-${++seq}`
  const opsRef = Ref.unsafeMake<ReadonlyArray<Operation>>([])
  const stepsRef = Ref.unsafeMake<ReadonlyArray<OperationStep>>([])

  const layer = Layer.succeed(OperationRepo, {
    hasUnfinished: Ref.get(opsRef).pipe(Effect.map((rows) => rows.some(isOperationUnfinished))),
    hasUnfinishedByContestAndKind: (contestId, kind) =>
      Ref.get(opsRef).pipe(
        Effect.map((rows) =>
          rows.some(
            (o) =>
              o.contestId === contestId &&
              o.kind === kind &&
              (o.status === "queued" ||
                o.status === "running" ||
                o.status === "blocked" ||
                o.status === "failed")
          )
        )
      ),
    enqueue: (input: NewOperation) =>
      Effect.gen(function* () {
        if (input.steps.length === 0) {
          return yield* Effect.dieMessage(`enqueue: kind '${input.kind}' has zero steps`)
        }
        const existing = yield* Ref.get(opsRef)
        if (existing.some(isOperationUnfinished)) {
          return yield* Effect.fail(new OperationInProgress())
        }
        const now = Date.now()
        const op = new Operation({
          id: nextId() as unknown as OperationId,
          contestId: input.contestId,
          kind: input.kind,
          status: "queued",
          actor: input.actor,
          planDigest: input.planDigest,
          contestRevision: input.contestRevision,
          sanitizedError: Option.none(),
          createdAt: now,
          startedAt: Option.none(),
          finishedAt: Option.none()
        })
        yield* Ref.update(opsRef, (rows) => [...rows, op])
        const steps = input.steps.map(
          (s) =>
            new OperationStep({
              id: nextId() as unknown as OperationStepId,
              operationId: op.id,
              ordinal: s.ordinal,
              stepKey: s.stepKey,
              status: "queued",
              attempt: 0,
              continueOnError: s.continueOnError,
              retryAt: Option.none(),
              leaseExpiresAt: Option.none(),
              inputSummary: s.inputSummary,
              progressJson: "{}",
              resultSummary: Option.none(),
              sanitizedError: Option.none(),
              createdAt: now,
              startedAt: Option.none(),
              finishedAt: Option.none()
            })
        )
        yield* Ref.update(stepsRef, (rows) => [...rows, ...steps])
        return op
      }),
    findById: (id) =>
      Ref.get(opsRef).pipe(
        Effect.map((rows) => Option.fromNullable(rows.find((o) => o.id === id)))
      ),
    listSteps: (id) =>
      Ref.get(stepsRef).pipe(
        Effect.map((rows) => rows.filter((s) => s.operationId === id))
      ),
    listByContest: (contestId, limit) =>
      Ref.get(opsRef).pipe(
        Effect.map((rows) =>
          rows
            .filter((o) => o.contestId === contestId)
            .slice()
            .sort((a, b) => b.createdAt - a.createdAt || (b.id > a.id ? 1 : -1))
            .slice(0, limit)
        )
      ),
    claimNext: () => Effect.dieMessage("makeOperationRepoTest: claimNext not implemented"),
    completeStep: () => Effect.dieMessage("makeOperationRepoTest: completeStep not implemented"),
    failStep: () => Effect.dieMessage("makeOperationRepoTest: failStep not implemented"),
    blockStep: () => Effect.dieMessage("makeOperationRepoTest: blockStep not implemented"),
    updateStepProgress: (stepId, progressJson) =>
      Ref.update(stepsRef, (rows) =>
        rows.map((s) =>
          s.id === stepId && s.status === "running"
            ? new OperationStep({ ...s, progressJson })
            : s
        )
      ),
    resumeExpired: () => Effect.succeed(0),
    // review #5: 実 SQL 実装(operationRepo.ts の retry/cancel)は current
    // status を SELECT してから InvalidOperationTransition の from に載せる。
    // in-memory 版もこれに揃えないと、retry 対象が blocked / failed のとき
    // 「from='succeeded'」という嘘の from が返り、from に対する assertion で
    // regression を見落とす(review #5 の指摘)。
    retry: (id, _now) =>
      Ref.get(opsRef).pipe(
        Effect.flatMap((rows) => {
          const row = rows.find((o) => o.id === id)
          const from = row?.status ?? ("succeeded" as const)
          return Effect.fail(new InvalidOperationTransition({ from, to: "running" }))
        })
      ),
    cancel: (id, _now) =>
      Ref.get(opsRef).pipe(
        Effect.flatMap((rows) => {
          const row = rows.find((o) => o.id === id)
          const from = row?.status ?? ("succeeded" as const)
          return Effect.fail(new InvalidOperationTransition({ from, to: "canceled" }))
        })
      )
  })

  return {
    layer,
    get: (id: OperationId) =>
      Ref.get(opsRef).pipe(Effect.map((rows) => Option.fromNullable(rows.find((o) => o.id === id))))
  }
}

// Task 8: contestAdmin テスト用の軽量 OperationRepo。beginContestPreparation の
// unfinished_operation ガードは hasUnfinished のみを触るため、他のメソッドは
// defect にして「今そのメソッドを呼んだテストは想定外」を明示する。
export const makeOperationRepoStubTest = (
  args: { readonly hasUnfinished: boolean } = { hasUnfinished: false }
): Layer.Layer<OperationRepo> =>
  Layer.succeed(OperationRepo, {
    hasUnfinished: Effect.succeed(args.hasUnfinished),
    hasUnfinishedByContestAndKind: () => Effect.succeed(false),
    enqueue: () => Effect.dieMessage("makeOperationRepoStubTest: enqueue not implemented"),
    findById: () => Effect.succeed(Option.none()),
    listSteps: () => Effect.succeed([]),
    listByContest: () => Effect.succeed([]),
    claimNext: () => Effect.succeed(Option.none()),
    completeStep: () => Effect.dieMessage("makeOperationRepoStubTest: completeStep not implemented"),
    failStep: () => Effect.dieMessage("makeOperationRepoStubTest: failStep not implemented"),
    blockStep: () => Effect.dieMessage("makeOperationRepoStubTest: blockStep not implemented"),
    updateStepProgress: () => Effect.void,
    resumeExpired: () => Effect.succeed(0),
    retry: () => Effect.dieMessage("makeOperationRepoStubTest: retry not implemented"),
    cancel: () => Effect.dieMessage("makeOperationRepoStubTest: cancel not implemented")
  })

// Task 10: RunnerAgentRepo のインメモリ実装。touch は id 一意で upsert し、
// getFresh は now - lastSeenAt <= maxAgeMillis の最新 1 台を返す。
// initial 行は now 相対時刻を渡してテスト側で「新鮮 / stale」を作り分ける。
export type RunnerAgentTestRow = {
  readonly id: string
  readonly revision: string
  readonly benchReady: boolean
  readonly healthSummary: string
  readonly lastSeenAt: number
}

export const makeRunnerAgentRepoTest = (
  initial: ReadonlyArray<RunnerAgentTestRow> = []
): Layer.Layer<RunnerAgentRepo> =>
  Layer.effect(
    RunnerAgentRepo,
    Effect.gen(function* () {
      const rowsRef = yield* Ref.make<ReadonlyArray<RunnerAgentTestRow>>(initial)
      return {
        touch: (agent) =>
          Ref.update(rowsRef, (rows) => {
            const idx = rows.findIndex((r) => r.id === agent.id)
            if (idx < 0) return [...rows, agent]
            const next = rows.slice()
            next[idx] = agent
            return next
          }),
        getFresh: (now, maxAgeMillis) =>
          Ref.get(rowsRef).pipe(
            Effect.map((rows) => {
              const fresh = rows
                .filter((r) => now - r.lastSeenAt <= maxAgeMillis)
                .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
              return fresh.length === 0 ? Option.none() : Option.some(fresh[0])
            })
          ),
        listAll: Ref.get(rowsRef).pipe(Effect.map((rows) => rows.slice().sort((a, b) => (a.id < b.id ? -1 : 1))))
      }
    })
  )

// Task 10: BackupPort のインメモリ実装。probe は options.failWith が渡されて
// いればその BackupError で常に fail し、それ以外は成功する(readiness の
// backup=pass 分岐 / fail 分岐を切り替えるだけの最小実装)。実 FS canary を
// 触るテストは test/infrastructure/backupProbe.test.ts が担当する。
export interface BackupPortTestOptions {
  readonly failWith?: BackupError
}

// Task 11 で BackupPort が createSnapshot/writeArtifact/readArtifact を要求
// するようになったが、多くの http テスト(backup が絡まない場面)は「呼ばれ
// たら意図しない」= die で十分。artifact テストは実 FS を触るので専用の
// makeArtifactBackupPortTest を作る(下記)。
export const makeBackupPortTest = (options: BackupPortTestOptions = {}): Layer.Layer<BackupPort> =>
  Layer.succeed(BackupPort, {
    probe:
      options.failWith === undefined
        ? Effect.void
        : Effect.fail(options.failWith),
    createSnapshot: () => Effect.dieMessage("makeBackupPortTest: createSnapshot not implemented"),
    writeArtifact: () => Effect.dieMessage("makeBackupPortTest: writeArtifact not implemented"),
    readArtifact: () => Effect.dieMessage("makeBackupPortTest: readArtifact not implemented")
  })

// Task 11: 実 FS 上に scoreboard/scoreboard_csv/snapshot を書ける in-memory
// (実は on-disk)実装。呼び出しごとに一時ディレクトリを掘り、書き込む。
// テスト側で作った root を渡す使い方(root 自体は mkdtempSync 等でテストが
// 用意する)。snapshot は better-sqlite3 に依らないダミー bytes を書く
// (実 online backup の検証は test/infrastructure/sqliteBackup.test.ts の
// snapshotAt 経由で行う; ここでは finish/backup Operation の step 分岐や
// upsert 経路が動くことが検証対象)。

export interface ArtifactBackupPortTestOptions {
  readonly root: string
  readonly snapshotBytes?: (contestId: ContestId, edition: number) => Uint8Array
}

const encodeUtf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

export const makeArtifactBackupPortTest = (
  options: ArtifactBackupPortTestOptions
): Layer.Layer<BackupPort> => {
  const rootAbs = pathResolve(options.root)
  const write = async (subpath: string, bytes: Uint8Array): Promise<{ storagePath: string; sha256: string; sizeBytes: number }> => {
    const dest = pathJoin(rootAbs, subpath)
    await fsp.mkdir(pathResolve(dest, ".."), { recursive: true, mode: 0o700 })
    await fsp.writeFile(dest, bytes, { mode: 0o600 })
    const sha = createHash("sha256").update(bytes).digest("hex")
    return { storagePath: dest, sha256: sha, sizeBytes: bytes.byteLength }
  }
  return Layer.succeed(BackupPort, {
    probe: Effect.void,
    createSnapshot: (args) =>
      Effect.tryPromise({
        try: async () => {
          const bytes = options.snapshotBytes?.(args.contestId, args.edition) ?? encodeUtf8(`snapshot:c${args.contestId}:e${args.edition}`)
          const subpath = `contests/${args.contestId}/e${args.edition}/snapshot.sqlite`
          return await write(subpath, bytes)
        },
        catch: (cause) => new _BackupErrorTag({ reason: "io_error", detail: String(cause) })
      }),
    writeArtifact: (args) =>
      Effect.tryPromise({
        try: async () => {
          const filename = args.kind === "scoreboard" ? "scoreboard.json" : "scoreboard.csv"
          const subpath = `contests/${args.contestId}/e${args.edition}/${filename}`
          return await write(subpath, args.bytes)
        },
        catch: (cause) => new _BackupErrorTag({ reason: "io_error", detail: String(cause) })
      }),
    readArtifact: (storagePath) =>
      Effect.tryPromise({
        try: async () => {
          const canonical = pathResolve(storagePath)
          const guard = rootAbs.endsWith(pathSep) ? rootAbs : rootAbs + pathSep
          if (canonical !== rootAbs && !canonical.startsWith(guard)) {
            throw new _BackupErrorTag({ reason: "destination_outside_root", detail: "outside root" })
          }
          const buf = await fsp.readFile(canonical)
          return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        },
        catch: (cause) =>
          cause instanceof _BackupErrorTag
            ? cause
            : new _BackupErrorTag({ reason: "io_error", detail: String(cause) })
      })
  })
}
