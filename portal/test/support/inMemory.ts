import { Context, Effect, Either, Layer, Option, Ref } from "effect"
import { cancelJob, failJob, finishJob, recordProgress, startJob } from "../../src/domain/benchJob.js"
import type { BenchJob } from "../../src/domain/benchJob.js"
import type { Contest } from "../../src/domain/contest.js"
import { CannotCancelRunning, InvalidJobTransition, TeamJobAlreadyQueued } from "../../src/domain/errors.js"
import type { BenchJobId, TeamId } from "../../src/domain/ids.js"
import { UserId } from "../../src/domain/ids.js"
import { User } from "../../src/domain/user.js"
import type { Team } from "../../src/domain/team.js"
import {
  BenchJobRepo,
  ContestRepo,
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
                isAdmin: u.isAdmin
              })
              return [created, [...users, created]]
            })
          }),
        findById: (id) =>
          Ref.get(usersRef).pipe(Effect.map((users) => Option.fromNullable(users.find((u) => u.id === id))))
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
