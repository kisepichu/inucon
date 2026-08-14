import { Context, Data, Effect, Option } from "effect"
import type { BenchJob, BenchJobPurpose } from "../domain/benchJob.js"
import type { Contest } from "../domain/contest.js"
import {
  CannotCancelRunning,
  ContestEditionConflict,
  ContestRevisionConflict,
  DuplicateInstanceIndex,
  InvalidJobTransition,
  OperationalContestConflict,
  TeamJobAlreadyQueued,
  TeamNumberConflict
} from "../domain/errors.js"
import type { BenchJobId, ContestId, InstanceId, TeamId, UserId } from "../domain/ids.js"
import type { Instance } from "../domain/instance.js"
import type { Team } from "../domain/team.js"
import type { TeamInvite } from "../domain/teamInvite.js"
import type { User } from "../domain/user.js"
import { InstanceNotRunning, ProvisionInProgress, QuotaExceeded } from "./errors.js"

// リポジトリ層(infrastructure、Task 4 が実装)の失敗はすべてこれに包む。
export class RepoError extends Data.TaggedError("RepoError")<{ cause: unknown }> {}

// GitHub OAuth コード交換の失敗。
export class OAuthFailed extends Data.TaggedError("OAuthFailed")<{ cause: unknown }> {}

// Proxmox VE API 呼び出しの失敗(HTTP 層・タスク失敗など)。
export class ProxmoxError extends Data.TaggedError("ProxmoxError")<{ cause: unknown }> {}

// Cloudflare API 呼び出しの失敗(DNS / tunnel configurations / Access)。
export class CloudflareError extends Data.TaggedError("CloudflareError")<{ cause: unknown }> {}

// GitHub 公開鍵取得の失敗(鍵未登録 = 空を含む)。
export class GithubKeysError extends Data.TaggedError("GithubKeysError")<{ cause: unknown }> {}

// waitForGuestAgent が timeoutMillis 以内に guest agent の応答を確認できなかった。
export class ProvisionTimeout extends Data.TaggedError("ProvisionTimeout")<{
  vmid: number
  timeoutMillis: number
}> {}

export class UuidGen extends Context.Tag("app/UuidGen")<
  UuidGen,
  { readonly next: Effect.Effect<string> }
>() {}

// Task 3: Contest は contest スコープの正となる履歴付き集約。単一 contest 運用の
// ブリッジ層(getCurrent/save)は解消し、明示的な list / findById / operational /
// display と楽観ロック付き saveIfRevision に置き換える。
//
// - list: 全 contest(canceled 含む)を edition 降順で返す。admin ダッシュボード用。
// - findById: ID 指定で 1 件。canceled/finished を含めて返すため public 側は
//   ハンドラで status を絞る。
// - getOperational: preparing/running/finalizing のうち 1 件(0004 の
//   idx_contests_single_operational で最大 1 保証)。start/finish 系の操作用。
// - getDisplay: 「今表示すべき contest」の選択。running/finalizing 優先、次に
//   最新 finished(finishedAt DESC、edition DESC のタイブレーク)、それも無ければ
//   preparing。canceled はここに含めない(admin の list からのみ辿れる)。
//   準備中は最終スコアを消さないため running/finalizing より下位。
// - create: 新規 contest 挿入。edition の partial unique に反すれば
//   ContestEditionConflict、single-operational に反すれば OperationalContestConflict。
// - saveIfRevision: 楽観ロック付き更新。expectedRevision と DB 現在値が一致
//   すれば新 revision で書き込み、ズレていれば ContestRevisionConflict を返す
//   (respond で actual revision も返して呼び出し元が再取得できるようにする)。
export class ContestRepo extends Context.Tag("app/ContestRepo")<
  ContestRepo,
  {
    readonly list: Effect.Effect<ReadonlyArray<Contest>, RepoError>
    readonly findById: (id: ContestId) => Effect.Effect<Option.Option<Contest>, RepoError>
    readonly getOperational: Effect.Effect<Option.Option<Contest>, RepoError>
    readonly getDisplay: Effect.Effect<Option.Option<Contest>, RepoError>
    readonly create: (
      contest: Contest
    ) => Effect.Effect<void, RepoError | ContestEditionConflict | OperationalContestConflict>
    readonly saveIfRevision: (
      contest: Contest,
      expectedRevision: number
    ) => Effect.Effect<Contest, RepoError | ContestRevisionConflict>
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
    // PUT /api/teams/:id/members のバリデーション(未ログイン login の検出)用。
    // 渡された githubLogins のうち実在する行だけを返す(存在しない login は
    // 結果に現れない → 呼び出し元が差分を取って UnknownGithubLogins を判定する)。
    readonly findManyByGithubLogins: (
      logins: ReadonlyArray<string>
    ) => Effect.Effect<ReadonlyArray<User>, RepoError>
    // POST /api/admin/teams/:id/invites(Phase 3、Task 5): Access ログイン用
    // メールを更新する。既ログインユーザーへの即時招待、および初ログイン時の
    // team_invites 消費(auth.ts)の両方から呼ばれる。
    readonly setEmail: (id: UserId, email: string) => Effect.Effect<void, RepoError>
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

// Task 3: Team は contest スコープ。すべての参照/変更に contestId を必ず含める。
export class TeamRepo extends Context.Tag("app/TeamRepo")<
  TeamRepo,
  {
    readonly listByContest: (contestId: ContestId) => Effect.Effect<ReadonlyArray<Team>, RepoError>
    readonly findById: (contestId: ContestId, teamId: TeamId) => Effect.Effect<Option.Option<Team>, RepoError>
    readonly findByUserId: (contestId: ContestId, userId: UserId) => Effect.Effect<Option.Option<Team>, RepoError>
    // team_number の UNIQUE(contest_id, team_number)違反は TeamNumberConflict にマップ。
    readonly create: (t: Team) => Effect.Effect<void, RepoError | TeamNumberConflict>
    readonly setMembers: (
      contestId: ContestId,
      teamId: TeamId,
      userIds: ReadonlyArray<UserId>
    ) => Effect.Effect<void, RepoError>
    // 単一メンバー追加(招待/初ログイン)。scoped unique(contest_id, user_id)
    // で TOCTOU 判定する。true = 追加成功、false = そのユーザーは既に当該
    // contest 内のどこかのチームへ所属していて追加されなかった。
    readonly addMember: (
      contestId: ContestId,
      teamId: TeamId,
      userId: UserId
    ) => Effect.Effect<boolean, RepoError>
    readonly listMembers: (
      contestId: ContestId,
      teamId: TeamId
    ) => Effect.Effect<ReadonlyArray<User>, RepoError>
  }
>() {}

// Task 3: team_invites テーブル(migration 0005)は contest スコープ。
// (contestId, githubLogin) が PK。同一 contest 内の再招待は upsert。
export class InviteRepo extends Context.Tag("app/InviteRepo")<
  InviteRepo,
  {
    readonly create: (invite: TeamInvite) => Effect.Effect<void, RepoError>
    readonly findByGithubLogin: (
      contestId: ContestId,
      githubLogin: string
    ) => Effect.Effect<Option.Option<TeamInvite>, RepoError>
    readonly delete: (contestId: ContestId, githubLogin: string) => Effect.Effect<void, RepoError>
    readonly listByTeam: (
      contestId: ContestId,
      teamId: TeamId
    ) => Effect.Effect<ReadonlyArray<TeamInvite>, RepoError>
    // 初ログイン時の全 live contest 招待消費(auth.ts、Task 3 Step 5)。
    // draft/preparing/running/finalizing のいずれかの contest に紐づく
    // (contestId, githubLogin) 行を全部返す。finished/canceled は無視する。
    readonly listByGithubLoginForLiveContests: (
      githubLogin: string
    ) => Effect.Effect<ReadonlyArray<TeamInvite>, RepoError>
  }
>() {}

export class InstanceRepo extends Context.Tag("app/InstanceRepo")<
  InstanceRepo,
  {
    readonly listByContest: (contestId: ContestId) => Effect.Effect<ReadonlyArray<Instance>, RepoError>
    readonly listByTeam: (
      contestId: ContestId,
      teamId: TeamId
    ) => Effect.Effect<ReadonlyArray<Instance>, RepoError>
    readonly findById: (id: InstanceId) => Effect.Effect<Option.Option<Instance>, RepoError>
    readonly create: (i: Instance) => Effect.Effect<Instance, RepoError | DuplicateInstanceIndex>
    readonly remove: (id: InstanceId) => Effect.Effect<void, RepoError>
    readonly createIfAllowed: (
      i: Instance,
      quota: number
    ) => Effect.Effect<Instance, RepoError | QuotaExceeded | ProvisionInProgress | DuplicateInstanceIndex>
    readonly beginDeletingIfAllowed: (
      instanceId: InstanceId,
      now: number
    ) => Effect.Effect<Option.Option<Instance>, RepoError>
    readonly update: (i: Instance) => Effect.Effect<void, RepoError>
    readonly findNextForOrchestration: Effect.Effect<Option.Option<Instance>, RepoError>
  }
>() {}

export class BenchJobRepo extends Context.Tag("app/BenchJobRepo")<
  BenchJobRepo,
  {
    readonly insertIfAllowed: (
      job: BenchJob,
      requireRunningInstance?: { instanceId: InstanceId; teamId: TeamId }
    ) => Effect.Effect<BenchJob, RepoError | TeamJobAlreadyQueued | InstanceNotRunning>
    readonly findById: (id: BenchJobId) => Effect.Effect<Option.Option<BenchJob>, RepoError>
    readonly listByTeam: (
      contestId: ContestId,
      teamId: TeamId,
      limit: number
    ) => Effect.Effect<ReadonlyArray<BenchJob>, RepoError>
    // Task 3: 「今 dequeue 可能な contest」の情報を渡す。running contest には
    // purpose='competition'、preparing contest には purpose='rehearsal' のみを
    // 拾う。全体 running=0 のときだけ動く点は従来どおり。
    readonly dequeueNextQueued: (
      candidate: { contestId: ContestId; purpose: BenchJobPurpose },
      now: number
    ) => Effect.Effect<Option.Option<BenchJob>, RepoError>
    readonly appendLog: (id: BenchJobId, chunk: string) => Effect.Effect<void, RepoError>
    readonly getLog: (id: BenchJobId) => Effect.Effect<string, RepoError>
    readonly failTimedOutJobs: (cutoff: number, now: number) => Effect.Effect<number, RepoError>
    readonly recordProgressIfRunning: (
      id: BenchJobId,
      now: number
    ) => Effect.Effect<BenchJob, RepoError | InvalidJobTransition>
    readonly finishIfRunning: (
      id: BenchJobId,
      result: { score: number; passed: boolean },
      now: number
    ) => Effect.Effect<BenchJob, RepoError | InvalidJobTransition>
    readonly failIfRunning: (
      id: BenchJobId,
      errorMessage: string,
      now: number
    ) => Effect.Effect<BenchJob, RepoError | InvalidJobTransition>
    readonly cancelIfQueued: (
      id: BenchJobId
    ) => Effect.Effect<BenchJob, RepoError | CannotCancelRunning | InvalidJobTransition>
    // preparing→running 遷移で残っている queued rehearsal を一括キャンセルする。
    // insertIfAllowed の NOT EXISTS ガードは purpose 非依存で「チームごと
    // 1 active job」を強制するため、これを残すと running 中に同一チームが
    // competition を enqueue できなくなる。Task 10 の guarded_start Operation
    // が正式化されたらこの port は不要になる予定。
    readonly cancelQueuedRehearsalsForContest: (contestId: ContestId) => Effect.Effect<void, RepoError>
    // Task 3: scoreboard は contest スコープ。purpose='competition' の finished
    // のみを集計対象にする。0 件チームも desiredInstanceCount 分の枠として
    // 返す(呼び出し元の handler が scope 済み teams と JOIN 済みの結果を受け取る)。
    readonly scoreboard: (contestId: ContestId) => Effect.Effect<
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

// 認証まわりの設定(ADMIN_GITHUB_LOGINS 由来)。Layer は main.ts で
// Config から組み立てる(テストでは Layer.succeed で注入)。
export class AuthConfig extends Context.Tag("app/AuthConfig")<
  AuthConfig,
  { readonly adminGithubLogins: ReadonlyArray<string> }
>() {}

// Proxmox VE API(https://192.0.2.10:8006/api2/json)。トークン認証。
// Phase 3 のインスタンス払い出し/撤収オーケストレーション(Task 4)が使う。
export class ProxmoxPort extends Context.Tag("app/ProxmoxPort")<
  ProxmoxPort,
  {
    readonly cloneVm: (args: {
      templateVmid: number
      newVmid: number
      name: string
    }) => Effect.Effect<void, ProxmoxError>
    readonly configureCloudInit: (args: {
      vmid: number
      ip: string
      gateway: string
      sshKeys: string
    }) => Effect.Effect<void, ProxmoxError>
    readonly setVnet: (args: { vmid: number; bridge: string }) => Effect.Effect<void, ProxmoxError>
    readonly startVm: (vmid: number) => Effect.Effect<void, ProxmoxError>
    // 冪等: VM が既に存在しない場合も成功扱い。
    readonly stopAndDestroyVm: (vmid: number) => Effect.Effect<void, ProxmoxError>
    readonly vmExists: (vmid: number) => Effect.Effect<boolean, ProxmoxError>
    readonly waitForGuestAgent: (
      vmid: number,
      timeoutMillis: number
    ) => Effect.Effect<void, ProxmoxError | ProvisionTimeout>
    readonly guestExec: (args: {
      vmid: number
      command: ReadonlyArray<string>
    }) => Effect.Effect<{ exitcode: number; out: string }, ProxmoxError>
    readonly getNodeFreeMemBytes: Effect.Effect<number, ProxmoxError>
  }
>() {}

// Cloudflare API(DNS / Tunnel remote config / Access)。Phase 1-2 の runbook
// (ダッシュボード手動運用)実績の API 化。すべて冪等(ensure/remove)。
export class CloudflarePort extends Context.Tag("app/CloudflarePort")<
  CloudflarePort,
  {
    // DNS CNAME(→ benchvm tunnel)+ tunnel ingress(ssh://ip:22)の追加/更新。
    readonly ensureInstanceRoute: (args: {
      hostname: string
      ip: string
    }) => Effect.Effect<void, CloudflareError>
    readonly removeInstanceRoute: (hostname: string) => Effect.Effect<void, CloudflareError>
    // Access アプリ作成 or ポリシー更新(現行 include との和集合で PUT — 締め出し防止)。
    readonly ensureAccessApp: (args: {
      hostname: string
      emails: ReadonlyArray<string>
    }) => Effect.Effect<void, CloudflareError>
    readonly removeAccessApp: (hostname: string) => Effect.Effect<void, CloudflareError>
  }
>() {}

// GitHub 公開鍵の取得(https://github.com/<login>.keys)。
export class GithubKeysPort extends Context.Tag("app/GithubKeysPort")<
  GithubKeysPort,
  {
    // 空(鍵未登録)は GithubKeysError。authorized_keys 形式として不正な行は除去する。
    readonly fetchKeys: (login: string) => Effect.Effect<ReadonlyArray<string>, GithubKeysError>
  }
>() {}

// インスタンス払い出しのガード閾値・タイムアウト(Phase 3、Task 4)。main.ts で
// Config から組み立てる(RunnerConfig と同じ方針)。既定値はスペック §Instance
// 集約・spike メモ §リスク4: RAM は 5GiB(= 1 インスタンス 4GiB + 予備 1GiB)。
export class ProvisioningConfig extends Context.Tag("app/ProvisioningConfig")<
  ProvisioningConfig,
  {
    readonly minFreeMemBytes: number
    readonly guestAgentTimeoutMillis: number
  }
>() {}
