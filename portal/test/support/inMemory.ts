import { Context, Effect, Either, Layer, Option, Ref } from "effect"
import { cancelJob, failJob, finishJob, recordProgress, startJob } from "../../src/domain/benchJob.js"
import type { BenchJob } from "../../src/domain/benchJob.js"
import type { Contest } from "../../src/domain/contest.js"
import { CannotCancelRunning, DuplicateInstanceIndex, InvalidJobTransition, TeamJobAlreadyQueued } from "../../src/domain/errors.js"
import type { BenchJobId, InstanceId, TeamId } from "../../src/domain/ids.js"
import { UserId } from "../../src/domain/ids.js"
import type { Instance } from "../../src/domain/instance.js"
import { User } from "../../src/domain/user.js"
import type { Team } from "../../src/domain/team.js"
import type { TeamInvite } from "../../src/domain/teamInvite.js"
import { ProvisionInProgress, QuotaExceeded } from "../../src/application/errors.js"
import {
  BenchJobRepo,
  CloudflareError,
  CloudflarePort,
  ContestRepo,
  GithubKeysError,
  GithubKeysPort,
  InstanceRepo,
  InviteRepo,
  ProvisioningConfig,
  ProvisionTimeout,
  ProxmoxError,
  ProxmoxPort,
  RunnerConfig,
  SessionRepo,
  TeamRepo,
  UserRepo,
  UuidGen
} from "../../src/application/ports.js"

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

export const makeContestRepoTest = (
  initial: Option.Option<Contest> = Option.none()
): Layer.Layer<ContestRepo> =>
  Layer.effect(
    ContestRepo,
    Effect.gen(function* () {
      const ref = yield* Ref.make(initial)
      return {
        getCurrent: Ref.get(ref),
        save: (c: Contest) => Ref.set(ref, Option.some(c))
      }
    })
  )

export const makeTeamRepoTest = (args: {
  teams: ReadonlyArray<Team>
  memberships?: ReadonlyArray<{ userId: UserId; teamId: TeamId }>
  users?: ReadonlyArray<User>
}): Layer.Layer<TeamRepo> =>
  Layer.effect(
    TeamRepo,
    Effect.gen(function* () {
      const teamsRef = yield* Ref.make(args.teams)
      const membersRef = yield* Ref.make(args.memberships ?? [])
      const usersRef = yield* Ref.make(args.users ?? [])
      return {
        list: Ref.get(teamsRef),
        findById: (id: TeamId) =>
          Ref.get(teamsRef).pipe(Effect.map((teams) => Option.fromNullable(teams.find((t) => t.id === id)))),
        findByUserId: (userId: UserId) =>
          Effect.gen(function* () {
            const members = yield* Ref.get(membersRef)
            const teams = yield* Ref.get(teamsRef)
            const membership = members.find((m) => m.userId === userId)
            if (membership === undefined) return Option.none<Team>()
            return Option.fromNullable(teams.find((t) => t.id === membership.teamId))
          }),
        create: (t: Team) => Ref.update(teamsRef, (teams) => [...teams, t]),
        setMembers: (teamId: TeamId, userIds: ReadonlyArray<UserId>) =>
          Ref.update(membersRef, (members) => [
            ...members.filter((m) => m.teamId !== teamId),
            ...userIds.map((userId) => ({ userId, teamId }))
          ]),
        // 単一メンバー追加(招待フロー)。team_members.user_id は UNIQUE の
        // ため、既に(どのチームであれ)所属済みの userId は無視する(冪等)。
        addMember: (teamId: TeamId, userId: UserId) =>
          Ref.update(membersRef, (members) =>
            members.some((m) => m.userId === userId) ? members : [...members, { userId, teamId }]
          ),
        listMembers: (teamId: TeamId) =>
          Effect.gen(function* () {
            const members = yield* Ref.get(membersRef)
            const users = yield* Ref.get(usersRef)
            const memberIds = new Set(members.filter((m) => m.teamId === teamId).map((m) => m.userId))
            return users.filter((u) => memberIds.has(u.id))
          })
      }
    })
  )

// InviteRepo のインメモリ実装(team_invites)。create は本番 SQLite 実装
// (github_login PK の ON CONFLICT upsert)と同じ意味論: 同一 githubLogin の
// 再招待は team/email を上書きする。saga/provisioner のテストで空の InviteRepo
// を差し込むためにも使う(招待ゼロ = collectTeamAccess はメンバーのみ集約)。
export const makeInviteRepoTest = (initial: ReadonlyArray<TeamInvite> = []): Layer.Layer<InviteRepo> =>
  Layer.effect(
    InviteRepo,
    Effect.gen(function* () {
      const ref = yield* Ref.make(initial)
      return {
        create: (invite: TeamInvite) =>
          Ref.update(ref, (invites) => [
            ...invites.filter((i) => i.githubLogin !== invite.githubLogin),
            invite
          ]),
        findByGithubLogin: (githubLogin: string) =>
          Ref.get(ref).pipe(Effect.map((invites) => Option.fromNullable(invites.find((i) => i.githubLogin === githubLogin)))),
        delete: (githubLogin: string) =>
          Ref.update(ref, (invites) => invites.filter((i) => i.githubLogin !== githubLogin)),
        listByTeam: (teamId: TeamId) =>
          Ref.get(ref).pipe(Effect.map((invites) => invites.filter((i) => i.teamId === teamId)))
      }
    })
  )

// 招待フロー(Task 5)の application テスト用に、UserRepo / SessionRepo /
// TeamRepo / InviteRepo を単一の共有ストアから提供する複合レイヤー。本番
// SQLite は users テーブルを 1 つだけ持ち、TeamRepo.listMembers と
// UserRepo.setEmail が同じ行を見る。makeTeamRepoTest(独自 usersRef)と
// makeAuthReposTest(別の usersRef)を混ぜるとこの一貫性が崩れる(setEmail が
// listMembers に反映されない)ため、招待テストではこの複合レイヤーで users を
// 1 つに束ねる。
export const makeInviteReposTest = (args: {
  teams: ReadonlyArray<Team>
  users?: ReadonlyArray<User>
  memberships?: ReadonlyArray<{ userId: UserId; teamId: TeamId }>
  invites?: ReadonlyArray<TeamInvite>
}): Layer.Layer<UserRepo | SessionRepo | TeamRepo | InviteRepo> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const usersRef = yield* Ref.make<ReadonlyArray<User>>(args.users ?? [])
      const membersRef = yield* Ref.make<ReadonlyArray<{ userId: UserId; teamId: TeamId }>>(args.memberships ?? [])
      const teamsRef = yield* Ref.make<ReadonlyArray<Team>>(args.teams)
      const invitesRef = yield* Ref.make<ReadonlyArray<TeamInvite>>(args.invites ?? [])
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
        delete: (sessionId) => Ref.update(sessionsRef, (sessions) => sessions.filter((s) => s.sessionId !== sessionId))
      }

      const teamRepo: Context.Tag.Service<TeamRepo> = {
        list: Ref.get(teamsRef),
        findById: (id) =>
          Ref.get(teamsRef).pipe(Effect.map((teams) => Option.fromNullable(teams.find((t) => t.id === id)))),
        findByUserId: (userId) =>
          Effect.gen(function* () {
            const members = yield* Ref.get(membersRef)
            const teams = yield* Ref.get(teamsRef)
            const membership = members.find((m) => m.userId === userId)
            if (membership === undefined) return Option.none<Team>()
            return Option.fromNullable(teams.find((t) => t.id === membership.teamId))
          }),
        create: (t) => Ref.update(teamsRef, (teams) => [...teams, t]),
        setMembers: (teamId, userIds) =>
          Ref.update(membersRef, (members) => [
            ...members.filter((m) => m.teamId !== teamId),
            ...userIds.map((userId) => ({ userId, teamId }))
          ]),
        addMember: (teamId, userId) =>
          Ref.update(membersRef, (members) =>
            members.some((m) => m.userId === userId) ? members : [...members, { userId, teamId }]
          ),
        listMembers: (teamId) =>
          Effect.gen(function* () {
            const members = yield* Ref.get(membersRef)
            const users = yield* Ref.get(usersRef)
            const memberIds = new Set(members.filter((m) => m.teamId === teamId).map((m) => m.userId))
            return users.filter((u) => memberIds.has(u.id))
          })
      }

      const inviteRepo: Context.Tag.Service<InviteRepo> = {
        create: (invite) =>
          Ref.update(invitesRef, (invites) => [
            ...invites.filter((i) => i.githubLogin !== invite.githubLogin),
            invite
          ]),
        findByGithubLogin: (githubLogin) =>
          Ref.get(invitesRef).pipe(
            Effect.map((invites) => Option.fromNullable(invites.find((i) => i.githubLogin === githubLogin)))
          ),
        delete: (githubLogin) => Ref.update(invitesRef, (invites) => invites.filter((i) => i.githubLogin !== githubLogin)),
        listByTeam: (teamId) => Ref.get(invitesRef).pipe(Effect.map((invites) => invites.filter((i) => i.teamId === teamId)))
      }

      return Context.make(UserRepo, userRepo).pipe(
        Context.add(SessionRepo, sessionRepo),
        Context.add(TeamRepo, teamRepo),
        Context.add(InviteRepo, inviteRepo)
      )
    })
  )

// InstanceRepo のインメモリ実装。create は本番 SQLite 実装(instanceRepo.ts の
// INSERT ... WHERE NOT EXISTS ... RETURNING)と同じ意味論: 同一 (teamId, index)
// が既にあれば Ref.modify 内の単一操作で判定して DuplicateInstanceIndex を返す
// (TOCTOU を模した Ref 単一 update、makeBenchJobRepoTest.insertIfAllowed と同型)。
export const makeInstanceRepoTest = (initial: ReadonlyArray<Instance> = []): Layer.Layer<InstanceRepo> =>
  Layer.effect(
    InstanceRepo,
    Effect.gen(function* () {
      const instancesRef = yield* Ref.make(initial)
      return {
        listByTeam: (teamId: TeamId) =>
          Ref.get(instancesRef).pipe(
            Effect.map((instances) =>
              instances.filter((i) => i.teamId === teamId).sort((a, b) => a.index - b.index)
            )
          ),
        findById: (id: InstanceId) =>
          Ref.get(instancesRef).pipe(Effect.map((instances) => Option.fromNullable(instances.find((i) => i.id === id)))),
        create: (i: Instance) =>
          Ref.modify(
            instancesRef,
            (instances): readonly [Either.Either<Instance, DuplicateInstanceIndex>, ReadonlyArray<Instance>] => {
              const duplicate = instances.some((x) => x.teamId === i.teamId && x.index === i.index)
              if (duplicate) {
                return [Either.left(new DuplicateInstanceIndex({ teamId: i.teamId, index: i.index })), instances]
              }
              return [Either.right(i), [...instances, i]]
            }
          ).pipe(Effect.flatMap(Either.match({ onLeft: Effect.fail, onRight: Effect.succeed }))),
        remove: (id: InstanceId) => Ref.update(instancesRef, (instances) => instances.filter((i) => i.id !== id)),
        // requestCreateInstance(Task 4)専用の原子的 guard 付き INSERT。単一の
        // Ref.modify コールバック内で (1) quota、(2) 進行中無し、(3) idx 重複
        // 無し、を判定してから挿入する(本番 SQLite 実装の単一 INSERT ...
        // WHERE ... RETURNING 文と同じ TOCTOU 回避を Ref の単一操作で模す)。
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
                (x) => x.teamId === i.teamId && (x.status === "creating" || x.status === "running")
              ).length
              if (activeCount >= quota) {
                return [Either.left(new QuotaExceeded({ teamId: i.teamId, quota })), instances]
              }
              const inProgress = instances.some(
                (x) => x.teamId === i.teamId && (x.status === "creating" || x.status === "deleting")
              )
              if (inProgress) {
                return [Either.left(new ProvisionInProgress({ teamId: i.teamId })), instances]
              }
              const duplicate = instances.some(
                (x) =>
                  x.teamId === i.teamId &&
                  x.index === i.index &&
                  (x.status === "creating" || x.status === "running" || x.status === "deleting")
              )
              if (duplicate) {
                return [Either.left(new DuplicateInstanceIndex({ teamId: i.teamId, index: i.index })), instances]
              }
              return [Either.right(i), [...instances, i]]
            }
          ).pipe(Effect.flatMap(Either.match({ onLeft: Effect.fail, onRight: Effect.succeed }))),
        // saga(provisioning.ts)の各ステップ後の progress/status/errorMessage
        // 保存。id で 1 件を丸ごと置き換える(本番 SQLite 実装の UPDATE と同じ
        // 意味論)。
        update: (i: Instance) =>
          Ref.update(instancesRef, (instances) => instances.map((x) => (x.id === i.id ? i : x))),
        // ワーカー(provisioner.ts)が 1 tick で拾う対象。creating/deleting の
        // うち最も古い(createdAt 昇順)1 件を返す。
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

export const makeBenchJobRepoTest = (initial: ReadonlyArray<BenchJob> = []): Layer.Layer<BenchJobRepo> =>
  Layer.effect(
    BenchJobRepo,
    Effect.gen(function* () {
      const jobsRef = yield* Ref.make(initial)
      const logsRef = yield* Ref.make<Record<string, string>>({})

      // reportProgress/reportFinish/cancel 共通の「判定+更新」ヘルパー。単一の
      // Ref.modify コールバック内でジョブを引き、domain の遷移関数
      // (recordProgress/finishJob/cancelJob)を適用して書き戻すことで TOCTOU を
      // 回避する(ports.ts のコメントにある「条件付き UPDATE 1 文」の模擬)。
      // ジョブ自体が見つからない場合は defect(die)にする(既存方針どおり)。
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
                (j) => j.teamId === job.teamId && (j.status === "queued" || j.status === "running")
              )
              if (hasActiveForTeam) {
                return [Either.left(new TeamJobAlreadyQueued({ teamId: job.teamId })), jobs]
              }
              return [Either.right(job), [...jobs, job]]
            }
          ).pipe(Effect.flatMap(Either.match({ onLeft: Effect.fail, onRight: Effect.succeed }))),
        findById: (id: BenchJobId) =>
          Ref.get(jobsRef).pipe(Effect.map((jobs) => Option.fromNullable(jobs.find((j) => j.id === id)))),
        listByTeam: (teamId: TeamId, limit: number) =>
          Ref.get(jobsRef).pipe(
            Effect.map((jobs) =>
              jobs
                .filter((j) => j.teamId === teamId)
                .sort((a, b) => b.enqueuedAt - a.enqueuedAt)
                .slice(0, limit)
            )
          ),
        // 全体で running が 1 件でもあれば None。なければ最も古い queued を
        // startJob で running 化し、Ref の単一 modify 呼び出し内で読み取りと
        // 書き戻しを完結させることでアトミック性を模す。
        dequeueNextQueued: (now: number) =>
          Ref.modify(
            jobsRef,
            (jobs): readonly [Option.Option<BenchJob>, ReadonlyArray<BenchJob>] => {
              const anyRunning = jobs.some((j) => j.status === "running")
              if (anyRunning) return [Option.none(), jobs]
              const queued = jobs.filter((j) => j.status === "queued").sort((a, b) => a.enqueuedAt - b.enqueuedAt)
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
        appendLog: (id: BenchJobId, chunk: string) =>
          Ref.update(logsRef, (logs) => ({ ...logs, [id]: (logs[id] ?? "") + chunk })),
        getLog: (id: BenchJobId) => Ref.get(logsRef).pipe(Effect.map((logs) => logs[id] ?? "")),
        // running かつ lastProgressAt < cutoff のジョブを単一の Ref.modify
        // コールバック内で failed 化する(判定と更新を同一操作にすることで
        // reportFinish との TOCTOU を模擬的に回避する)。
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
        // Task 3 のユースケースでは未使用。scoreboard はチーム名の結合が要る
        // ため、必要になった時点(スコアボード関連タスク)でチームデータも
        // 受け取れるように拡張する。
        scoreboard: Effect.succeed([])
      }
    })
  )

export const RunnerConfigTest = (jobTimeoutMillis: number): Layer.Layer<RunnerConfig> =>
  Layer.succeed(RunnerConfig, { jobTimeoutMillis })

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
}

const emptyProxmoxState: ProxmoxTestState = {
  clonedVmids: [],
  configuredVmids: [],
  vnetByVmid: {},
  startedVmids: [],
  destroyedVmids: [],
  authorizedKeysByVmid: {},
  guestExecCalls: [],
  existingVmids: []
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
type ProxmoxFailWith = Partial<Record<Exclude<ProxmoxOperation, "waitForGuestAgent">, ProxmoxError>> & {
  waitForGuestAgent?: ProxmoxError | ProvisionTimeout
}

export const makeProxmoxPortTest = (
  options: {
    freeMemBytes?: number
    guestAgentReady?: boolean
    failWith?: ProxmoxFailWith
    // 「クラッシュ前に clone だけ成功したが progress は保存されなかった」を
    // 直接シードするための初期 vmExists 状態(Task 4 レビュー C1)。
    existingVmids?: ReadonlyArray<number>
  } = {}
): { layer: Layer.Layer<ProxmoxPort>; getState: Effect.Effect<ProxmoxTestState> } => {
  const stateRef = Ref.unsafeMake({ ...emptyProxmoxState, existingVmids: options.existingVmids ?? [] })
  const freeMemBytes = options.freeMemBytes ?? 6_000_000_000
  const guestAgentReady = options.guestAgentReady ?? true

  const guarded = <A>(
    op: Exclude<ProxmoxOperation, "waitForGuestAgent">,
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
      )
  })

  return { layer, getState: Ref.get(stateRef) }
}

export interface CloudflareTestState {
  readonly routesByHostname: Readonly<Record<string, string>>
  readonly accessEmailsByHostname: Readonly<Record<string, ReadonlyArray<string>>>
}

const emptyCloudflareState: CloudflareTestState = { routesByHostname: {}, accessEmailsByHostname: {} }

export type CloudflareOperation = "ensureInstanceRoute" | "removeInstanceRoute" | "ensureAccessApp" | "removeAccessApp"

export const makeCloudflarePortTest = (
  options: { failWith?: Partial<Record<CloudflareOperation, CloudflareError>> } = {}
): { layer: Layer.Layer<CloudflarePort>; getState: Effect.Effect<CloudflareTestState> } => {
  const stateRef = Ref.unsafeMake(emptyCloudflareState)

  const guarded = <A>(op: CloudflareOperation, succeed: Effect.Effect<A, never>): Effect.Effect<A, CloudflareError> => {
    const failure = options.failWith?.[op]
    return failure !== undefined ? Effect.fail(failure) : succeed
  }

  const layer = Layer.succeed(CloudflarePort, {
    ensureInstanceRoute: ({ hostname, ip }) =>
      guarded(
        "ensureInstanceRoute",
        Ref.update(stateRef, (s) => ({ ...s, routesByHostname: { ...s.routesByHostname, [hostname]: ip } }))
      ),
    removeInstanceRoute: (hostname) =>
      guarded(
        "removeInstanceRoute",
        Ref.update(stateRef, (s) => {
          const { [hostname]: _removed, ...rest } = s.routesByHostname
          return { ...s, routesByHostname: rest }
        })
      ),
    // 現行 include との和集合(締め出し防止。ports.ts の意味論をそのまま再現)。
    ensureAccessApp: ({ emails, hostname }) =>
      guarded(
        "ensureAccessApp",
        Ref.update(stateRef, (s) => {
          const current = s.accessEmailsByHostname[hostname] ?? []
          const union = Array.from(new Set([...current, ...emails]))
          return { ...s, accessEmailsByHostname: { ...s.accessEmailsByHostname, [hostname]: union } }
        })
      ),
    removeAccessApp: (hostname) =>
      guarded(
        "removeAccessApp",
        Ref.update(stateRef, (s) => {
          const { [hostname]: _removed, ...rest } = s.accessEmailsByHostname
          return { ...s, accessEmailsByHostname: rest }
        })
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
