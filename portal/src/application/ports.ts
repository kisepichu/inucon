import { Context, Data, Effect, Option } from "effect"
import type { BenchJob } from "../domain/benchJob.js"
import type { Contest } from "../domain/contest.js"
import {
  CannotCancelRunning,
  DuplicateInstanceIndex,
  InvalidJobTransition,
  TeamJobAlreadyQueued,
  TeamNumberConflict
} from "../domain/errors.js"
import type { BenchJobId, InstanceId, TeamId, UserId } from "../domain/ids.js"
import type { Instance } from "../domain/instance.js"
import type { Team } from "../domain/team.js"
import type { User } from "../domain/user.js"
import { ProvisionInProgress, QuotaExceeded } from "./errors.js"

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
    // PUT /api/teams/:id/members のバリデーション(未ログイン login の検出)用。
    // 渡された githubLogins のうち実在する行だけを返す(存在しない login は
    // 結果に現れない → 呼び出し元が差分を取って UnknownGithubLogins を判定する)。
    readonly findManyByGithubLogins: (
      logins: ReadonlyArray<string>
    ) => Effect.Effect<ReadonlyArray<User>, RepoError>
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
    // team_number の UNIQUE 制約違反は TeamNumberConflict にマップする
    // (benchJobRepo.insertIfAllowed と同じ「INSERT ... WHERE NOT EXISTS ...
    // RETURNING」の単一原子的操作で TOCTOU を回避する、SQLite 実装)。
    readonly create: (t: Team) => Effect.Effect<void, RepoError | TeamNumberConflict>
    readonly setMembers: (teamId: TeamId, userIds: ReadonlyArray<UserId>) => Effect.Effect<void, RepoError>
    readonly listMembers: (teamId: TeamId) => Effect.Effect<ReadonlyArray<User>, RepoError>
  }
>() {}

export class InstanceRepo extends Context.Tag("app/InstanceRepo")<
  InstanceRepo,
  {
    readonly listByTeam: (teamId: TeamId) => Effect.Effect<ReadonlyArray<Instance>, RepoError>
    // POST /api/bench-jobs: instanceId 指定時に privateIp を解決するために使う。
    readonly findById: (id: InstanceId) => Effect.Effect<Option.Option<Instance>, RepoError>
    // instances.(team_id, idx) の UNIQUE 制約は「INSERT ... SELECT ... WHERE
    // NOT EXISTS ... RETURNING」の単一原子的操作で検出する(TeamRepo.create /
    // benchJobRepo.insertIfAllowed と同じ TOCTOU 回避パターン、SQLite 実装)。
    // 0 行挿入なら DuplicateInstanceIndex。admin 専用の台帳取り込み経路
    // (createInstance ユースケース、Phase 2 からの引き継ぎ)専用で、quota/
    // 進行中チェックは行わない(取り込み対象は既に起動済みの実 VM)。
    readonly create: (i: Instance) => Effect.Effect<Instance, RepoError | DuplicateInstanceIndex>
    readonly remove: (id: InstanceId) => Effect.Effect<void, RepoError>
    // requestCreateInstance(Task 4、追加ボタン)専用の原子的 guard 付き
    // INSERT。単一操作内で (1) チームの creating+running 数 < quota、
    // (2) チームに進行中(creating/deleting)が無いこと、(3) (team_id, idx) の
    // 重複が無いこと、を検証してから INSERT する(TOCTOU 回避、
    // benchJobRepo.insertIfAllowed と同型)。0 行挿入時は原因を優先順位
    // (quota → 進行中 → 重複 index)で判定して対応する型付きエラーを返す。
    readonly createIfAllowed: (
      i: Instance,
      quota: number
    ) => Effect.Effect<Instance, RepoError | QuotaExceeded | ProvisionInProgress | DuplicateInstanceIndex>
    // saga(provisioning.ts)が各ステップ後に progress/status/errorMessage/
    // updatedAt を保存するための全量更新(id で 1 行を丸ごと置き換える)。
    readonly update: (i: Instance) => Effect.Effect<void, RepoError>
    // ワーカー(provisioner.ts)が 1 tick で拾う対象。creating/deleting のうち
    // 最も古い(createdAt 昇順)1 件を返す。全体で同時 1 インスタンスのみ
    // オーケストレーションする制約(スペック §アーキテクチャ)は、ワーカーが
    // 単一の非並行ループでこれを毎回 1 件だけ取得し、そのインスタンスの
    // saga を完了させてから次の tick に進むことで実現する(BenchJob の
    // dequeueNextQueued=全体 running 1 本と同型の設計意図。ただし instance の
    // 状態機械は saga 全体の完了まで creating/deleting のままなので、こちらは
    // 状態遷移による排他ではなく「ワーカーの取得順序」による排他)。
    readonly findNextForOrchestration: Effect.Effect<Option.Option<Instance>, RepoError>
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
    // finishIfRunning と対称: 実行自体の失敗(バイナリ異常終了等)の報告を
    // failed 化する。判定と更新は単一の原子的操作。SQLite 実装では
    // `UPDATE ... WHERE id=? AND status='running'` の条件付き UPDATE 1 文 +
    // RETURNING。0 行更新時は現在の status を読み直して型付きエラーを構築する。
    readonly failIfRunning: (
      id: BenchJobId,
      errorMessage: string,
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
