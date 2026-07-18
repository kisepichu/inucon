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
    // 単一メンバーの追加(全量置換の setMembers とは別に、Phase 3 の招待
    // フローが使う)。TOCTOU 回避のため「INSERT ... WHERE NOT EXISTS
    // (SELECT 1 FROM team_members WHERE user_id = ...) RETURNING」の単一
    // 原子的操作で判定する(TeamRepo.create と同型)。戻り値は「実際にこの
    // 呼び出しで追加できたか」: true = このチームへ新規追加した / false =
    // (呼び出し元の findByUserId チェック後、この INSERT までの間に競合した
    // 別の呼び出しなどで)既に何らかのチームに所属していて追加されなかった。
    // 呼び出し元(application/usecases/invites.ts・auth.ts)は false の場合、
    // 実際の所属チームを再確認して「要求チームと同じなら冪等成功」
    // 「異なるなら MemberConflict」を判定する責務を持つ。
    readonly addMember: (teamId: TeamId, userId: UserId) => Effect.Effect<boolean, RepoError>
    readonly listMembers: (teamId: TeamId) => Effect.Effect<ReadonlyArray<User>, RepoError>
  }
>() {}

// team_invites テーブル(migration 0002)の CRUD。githubLogin が PK なので
// 同一 login への再招待は team/email の上書き(create = upsert)でよい
// (スペック §Invite「同一 login の再招待は team/email 更新でよい」)。
export class InviteRepo extends Context.Tag("app/InviteRepo")<
  InviteRepo,
  {
    readonly create: (invite: TeamInvite) => Effect.Effect<void, RepoError>
    readonly findByGithubLogin: (githubLogin: string) => Effect.Effect<Option.Option<TeamInvite>, RepoError>
    readonly delete: (githubLogin: string) => Effect.Effect<void, RepoError>
    readonly listByTeam: (teamId: TeamId) => Effect.Effect<ReadonlyArray<TeamInvite>, RepoError>
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
    // requestDeleteInstance(削除ボタン)専用の原子的 guard 付き UPDATE(Task 6
    // レビュー #B、#D)。単一の UPDATE ... WHERE ... RETURNING 文で (1) 対象行が
    // running/failed であること、(2) 同じチームに(対象以外で)creating/deleting
    // の行が無いこと、(3) 対象の private_ip を targetIp とする queued/running な
    // bench_jobs が無いこと、を検証してから status を deleting に更新する
    // (TOCTOU 回避、createIfAllowed と同型)。listByTeam で読んでから update
    // する二段階実装だと、二つの並行リクエストが両方読み取りを通過して両方
    // deleting へ書き込めてしまう(チームにつき進行中は高々1件という不変条件
    // 違反)し、(3) が無いと削除と bench enqueue(insertIfAllowed の
    // requireRunningInstance ガード)が両方とも相手の書き込み前の状態を読んで
    // 両方成功し得る(Task 6 レビュー #D、ベンチ対象 VM の消失)。0 行更新なら
    // Option.none()(呼び出し元が再読み込みしてエラー種別を判定する)。
    readonly beginDeletingIfAllowed: (
      instanceId: InstanceId,
      now: number
    ) => Effect.Effect<Option.Option<Instance>, RepoError>
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
    // requireRunningInstance(Task 6 レビュー #D): enqueueBenchJob の instanceId
    // 起点の enqueue(bench.ts)だけが渡す省略可能な追加ガード。渡された場合、
    // 上記 INSERT の WHERE に「対象 instance が今も running であること」を
    // 単一原子操作の一部として追加する(手動 IP:port 指定の enqueue は
    // instance 行に対応しないため渡さない = 挙動不変)。この追加ガードで
    // 0 行になった場合、team のキュー不変条件(NOT EXISTS 側)が原因でなければ
    // InstanceNotRunning を返す(削除 UPDATE 側の bench_jobs チェックと対に
    // なる、TOCTOU 回避)。
    readonly insertIfAllowed: (
      job: BenchJob,
      requireRunningInstance?: { instanceId: InstanceId; teamId: TeamId; privateIp: string }
    ) => Effect.Effect<BenchJob, RepoError | TeamJobAlreadyQueued | InstanceNotRunning>
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
    // clone ステップを再入可能にするための存在確認(Task 4 レビュー C1)。
    // `GET /nodes/<node>/qemu/<vmid>/status/current` が 200 なら true、404 なら
    // false を返す。clone 成功直後・progress 保存前にプロセスが落ちた場合の
    // 再開時、この確認で「既に clone 済み」を検出して cloneVm の再実行(同一
    // vmid への二重 clone は Proxmox 側で失敗する)を避ける。
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
