import { Context, Data, Effect, Option } from "effect"
import type { BenchJob } from "../domain/benchJob.js"
import type { Contest } from "../domain/contest.js"
import { TeamJobAlreadyQueued } from "../domain/errors.js"
import type { BenchJobId, InstanceId, TeamId, UserId } from "../domain/ids.js"
import type { Instance } from "../domain/instance.js"
import type { Team } from "../domain/team.js"
import type { User } from "../domain/user.js"

// リポジトリ層(infrastructure、Task 4 が実装)の失敗はすべてこれに包む。
export class RepoError extends Data.TaggedError("RepoError")<{ cause: unknown }> {}

// GitHub OAuth コード交換の失敗。
export class OAuthFailed extends Data.TaggedError("OAuthFailed")<{ cause: unknown }> {}

export class UuidGen extends Context.Tag("app/UuidGen")<
  UuidGen,
  { readonly next: Effect.Effect<string> }
>() {}

export class ContestRepo extends Context.Tag("app/ContestRepo")<
  ContestRepo,
  {
    readonly getCurrent: Effect.Effect<Option.Option<Contest>, RepoError>
    readonly save: (c: Contest) => Effect.Effect<void, RepoError>
  }
>() {}

export class UserRepo extends Context.Tag("app/UserRepo")<
  UserRepo,
  {
    readonly upsertByGithub: (u: {
      githubId: number
      githubLogin: string
      displayName: string
      isAdmin: boolean
    }) => Effect.Effect<User, RepoError>
    readonly findById: (id: UserId) => Effect.Effect<Option.Option<User>, RepoError>
  }
>() {}

export class SessionRepo extends Context.Tag("app/SessionRepo")<
  SessionRepo,
  {
    // 戻り値 = sessionId(乱数はここで生成)
    readonly create: (userId: UserId, expiresAt: number) => Effect.Effect<string, RepoError>
    readonly findValidUser: (sessionId: string, now: number) => Effect.Effect<Option.Option<User>, RepoError>
    readonly delete: (sessionId: string) => Effect.Effect<void, RepoError>
  }
>() {}

export class TeamRepo extends Context.Tag("app/TeamRepo")<
  TeamRepo,
  {
    readonly list: Effect.Effect<ReadonlyArray<Team>, RepoError>
    readonly findById: (id: TeamId) => Effect.Effect<Option.Option<Team>, RepoError>
    readonly findByUserId: (id: UserId) => Effect.Effect<Option.Option<Team>, RepoError>
    readonly create: (t: Team) => Effect.Effect<void, RepoError>
    readonly setMembers: (teamId: TeamId, userIds: ReadonlyArray<UserId>) => Effect.Effect<void, RepoError>
    readonly listMembers: (teamId: TeamId) => Effect.Effect<ReadonlyArray<User>, RepoError>
  }
>() {}

export class InstanceRepo extends Context.Tag("app/InstanceRepo")<
  InstanceRepo,
  {
    readonly listByTeam: (teamId: TeamId) => Effect.Effect<ReadonlyArray<Instance>, RepoError>
    readonly create: (i: Instance) => Effect.Effect<void, RepoError>
    readonly remove: (id: InstanceId) => Effect.Effect<void, RepoError>
  }
>() {}

export class BenchJobRepo extends Context.Tag("app/BenchJobRepo")<
  BenchJobRepo,
  {
    // 「チームに queued/running なし」の再検証と INSERT を同一トランザクションで行う(TOCTOU 回避)
    readonly insertIfAllowed: (job: BenchJob) => Effect.Effect<BenchJob, RepoError | TeamJobAlreadyQueued>
    readonly findById: (id: BenchJobId) => Effect.Effect<Option.Option<BenchJob>, RepoError>
    readonly listByTeam: (teamId: TeamId, limit: number) => Effect.Effect<ReadonlyArray<BenchJob>, RepoError>
    // 全体 running=0 のときだけ先頭 queued を running 化(アトミック)
    readonly dequeueNextQueued: (now: number) => Effect.Effect<Option.Option<BenchJob>, RepoError>
    readonly save: (job: BenchJob) => Effect.Effect<void, RepoError>
    readonly appendLog: (id: BenchJobId, chunk: string) => Effect.Effect<void, RepoError>
    readonly getLog: (id: BenchJobId) => Effect.Effect<string, RepoError>
    // status='running' かつ lastProgressAt < cutoff のジョブをアトミックに
    // failed 化する(errorMessage="timeout", finishedAt=now)。判定と更新は
    // 単一の原子的操作(SQLite 実装では条件付き UPDATE 1 文)で行い、更新件数
    // を返す。reportFinish との競合で finished を上書きしないことはこの条件
    // 式が保証する。
    readonly failTimedOutJobs: (cutoff: number, now: number) => Effect.Effect<number, RepoError>
    readonly scoreboard: Effect.Effect<
      ReadonlyArray<{
        teamId: TeamId
        teamName: string
        latestScore: number | null
        bestScore: number | null
        latestAt: number | null
      }>,
      RepoError
    >
  }
>() {}

export class GithubOAuthPort extends Context.Tag("app/GithubOAuthPort")<
  GithubOAuthPort,
  {
    readonly authorizeUrl: (state: string) => string
    readonly exchangeCodeForUser: (
      code: string
    ) => Effect.Effect<{ githubId: number; githubLogin: string; displayName: string }, OAuthFailed>
  }
>() {}

export class RunnerConfig extends Context.Tag("app/RunnerConfig")<
  RunnerConfig,
  { readonly jobTimeoutMillis: number }
>() {}
