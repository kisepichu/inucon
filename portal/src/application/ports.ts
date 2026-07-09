import { Context, Data, Effect, Option } from "effect"
import type { BenchJob } from "../domain/benchJob.js"
import type { Contest } from "../domain/contest.js"
import { CannotCancelRunning, InvalidJobTransition, TeamJobAlreadyQueued } from "../domain/errors.js"
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
    // 存在チェックと INSERT を単一の条件付き INSERT 文で行う(TOCTOU 回避)。
    // SQLite 実装では
    // `INSERT ... SELECT ... WHERE NOT EXISTS (SELECT 1 FROM bench_jobs WHERE team_id=? AND status IN ('queued','running')) RETURNING ...`
    // の 1 文で判定と挿入をアトミックに行い、0 行挿入(= 既に queued/running
    // あり)なら TeamJobAlreadyQueued を返す。
    readonly insertIfAllowed: (job: BenchJob) => Effect.Effect<BenchJob, RepoError | TeamJobAlreadyQueued>
    readonly findById: (id: BenchJobId) => Effect.Effect<Option.Option<BenchJob>, RepoError>
    readonly listByTeam: (teamId: TeamId, limit: number) => Effect.Effect<ReadonlyArray<BenchJob>, RepoError>
    // 全体 running=0 のときだけ先頭 queued を running 化(アトミック)
    readonly dequeueNextQueued: (now: number) => Effect.Effect<Option.Option<BenchJob>, RepoError>
    readonly appendLog: (id: BenchJobId, chunk: string) => Effect.Effect<void, RepoError>
    readonly getLog: (id: BenchJobId) => Effect.Effect<string, RepoError>
    // status='running' かつ lastProgressAt < cutoff のジョブをアトミックに
    // failed 化する(errorMessage="timeout", finishedAt=now)。判定と更新は
    // 単一の原子的操作(SQLite 実装では条件付き UPDATE 1 文)で行い、更新件数
    // を返す。reportFinish との競合で finished を上書きしないことはこの条件
    // 式が保証する。
    readonly failTimedOutJobs: (cutoff: number, now: number) => Effect.Effect<number, RepoError>
    // 判定と更新は単一の原子的操作。SQLite 実装では
    // `UPDATE ... WHERE id=? AND status='running'` の条件付き UPDATE 1 文 +
    // RETURNING。0 行更新時は現在の status を読み直して型付きエラーを構築する。
    // ジョブ自体が存在しない場合は defect(die)でよい(ジョブ行は削除されない)。
    readonly recordProgressIfRunning: (
      id: BenchJobId,
      now: number
    ) => Effect.Effect<BenchJob, RepoError | InvalidJobTransition>
    // 判定と更新は単一の原子的操作。SQLite 実装では
    // `UPDATE ... WHERE id=? AND status='running'` の条件付き UPDATE 1 文 +
    // RETURNING。0 行更新時は現在の status を読み直して型付きエラーを構築する。
    // ジョブ自体が存在しない場合は defect(die)でよい(ジョブ行は削除されない)。
    readonly finishIfRunning: (
      id: BenchJobId,
      result: { score: number; passed: boolean },
      now: number
    ) => Effect.Effect<BenchJob, RepoError | InvalidJobTransition>
    // 判定と更新は単一の原子的操作。SQLite 実装では
    // `UPDATE ... WHERE id=? AND status='queued'` の条件付き UPDATE 1 文 +
    // RETURNING。0 行更新時は現在の status を読み直して型付きエラーを構築する
    // (running なら CannotCancelRunning、それ以外は InvalidJobTransition)。
    // ジョブ自体が存在しない場合は defect(die)でよい(ジョブ行は削除されない)。
    readonly cancelIfQueued: (
      id: BenchJobId
    ) => Effect.Effect<BenchJob, RepoError | CannotCancelRunning | InvalidJobTransition>
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
