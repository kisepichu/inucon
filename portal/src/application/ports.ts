import { Context, Data, Effect, Option } from "effect"
import type { BenchJob, BenchJobPurpose } from "../domain/benchJob.js"
import type { Contest } from "../domain/contest.js"
import {
  CannotCancelRunning,
  ContestEditionConflict,
  ContestRevisionConflict,
  DuplicateInstanceIndex,
  InvalidJobTransition,
  InvalidOperationTransition,
  OperationalContestConflict,
  TeamJobAlreadyQueued,
  TeamNumberConflict
} from "../domain/errors.js"
import type { Artifact } from "../domain/artifact.js"
import type {
  ArtifactId,
  BenchJobId,
  ContestId,
  InstanceId,
  OperationId,
  OperationStepId,
  ResourceBindingId,
  TeamId,
  UserId
} from "../domain/ids.js"
import type { Instance } from "../domain/instance.js"
import type {
  NewOperation,
  Operation,
  OperationStep,
  SanitizedOperationError
} from "../domain/operation.js"
import type { ResourceBinding } from "../domain/resourceBinding.js"
import type { Team } from "../domain/team.js"
import type { TeamInvite } from "../domain/teamInvite.js"
import type { User } from "../domain/user.js"
import type { StepOutcome } from "./usecases/operations.js"
import { InstanceNotRunning, MemberConflict, ProvisionInProgress, QuotaExceeded } from "./errors.js"

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

// Task 9: `ensureAccessAppExact` が既存 Access アプリのポリシー形状を「portal
// 所有(単一 allow policy かつ include が email のみ)」と識別できないときに
// 失敗する。generic な CloudflareError と別にしたのは:
// - 呼び出し元 (prepareContest / apply) は AmbiguousAccessPolicy を 422 に
//   落とし、operator に「手動整理が必要な hostname」を明示できる。
// - error 本体には hostname と reason(kind)しか載せない。既存 include
//   の生 email や外部 ID は絶対に運ばない (spec §credential)。
export type AmbiguousAccessPolicyReason =
  | "multiple_allow_policies"
  | "non_email_include_present"
  | "policy_shape_unknown"

export class AmbiguousAccessPolicy extends Data.TaggedError("AmbiguousAccessPolicy")<{
  readonly hostname: string
  readonly reason: AmbiguousAccessPolicyReason
}> {}

// waitForGuestAgent が timeoutMillis 以内に guest agent の応答を確認できなかった。
export class ProvisionTimeout extends Data.TaggedError("ProvisionTimeout")<{
  vmid: number
  timeoutMillis: number
}> {}

// Task 8: enter_contest_mode / return_normal_mode の guest shutdown / start
// が graceful timeout に達したときの型付きエラー。ProvisionTimeout と同じ
// 構造だが、mode transition は force stop を絶対に呼ばない前提のため専用型に
// して呼び出し元(operation worker + readiness / handler)から取り違えない。
export class ModeTransitionTimeout extends Data.TaggedError("ModeTransitionTimeout")<{
  readonly vmid: number
  readonly expected: "running" | "stopped"
  readonly timeoutMillis: number
}> {}

// Task 6: Operation enqueue が「他に unfinished Operation あり」または
// 「creating/deleting な Instance あり」で失敗したときの型付きエラー。
// cross-lock は SQL 側の atomic ガードで検出する(TeamJobAlreadyQueued と同型)。
export class OperationInProgress extends Data.TaggedError("OperationInProgress")<{}> {}

// OperationHandler の run が呼び出し内部で失敗したときの包み。step の再試行
// 判定は sanitizeOperationError の code を見て application 層が行う。
export class OperationExecutionError extends Data.TaggedError("OperationExecutionError")<{
  readonly cause: unknown
}> {}

export class UuidGen extends Context.Tag("app/UuidGen")<
  UuidGen,
  { readonly next: Effect.Effect<string> }
>() {}

// Task 5 review finding 3: 複数リポジトリ越しの read/write を単一の
// トランザクションで括るためのポート。SQL 側は sql.withTransaction を
// そのまま噛ませる。テスト側は passthrough(単純に effect を実行するだけ)。
// エフェクトの型は変わらない — 実装がトランザクション境界を追加するだけ。
export class TransactionRunner extends Context.Tag("app/TransactionRunner")<
  TransactionRunner,
  {
    readonly run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | RepoError, R>
  }
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
    // Task 5: cancel Operation は「contest 行の status を canceled に flip」
    // と「同 contest の team_invites を全削除」を1つのトランザクションで
    // 行う。呼び出し側の usecase (contestAdmin.cancelContest) は cancel 済み
    // Contest を渡し、リポジトリは楽観ロック更新 + DELETE を一気に走らせる。
    // Task 11 の finish_contest step も同じ理由でこの atomic 版を使う。
    readonly saveIfRevisionAndPurgeInvites: (
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
    ) => Effect.Effect<void, RepoError | MemberConflict>
    // 単一メンバー追加(招待/初ログイン)。scoped unique(contest_id, user_id)
    // で TOCTOU 判定する。true = 追加成功、false = そのユーザーは既に当該
    // contest 内のどこかのチームへ所属していて追加されなかった。
    readonly addMember: (
      contestId: ContestId,
      teamId: TeamId,
      userId: UserId
    ) => Effect.Effect<boolean, RepoError>
    // Task 5: draft wizard から呼ばれる roster copy。source contest の
    // teams / team_members / team_invites を target contest へ複製する。
    // usecase 側で新しい team ID を採番し、oldTeamId -> newTeamId の写像と
    // 複製後の全 team/member/invite 行を渡す。リポジトリは1つのトランザクション
    // で INSERT を回し、部分書き込みを残さない。
    readonly copyRoster: (args: {
      readonly targetContestId: ContestId
      readonly teams: ReadonlyArray<Team>
      readonly memberships: ReadonlyArray<{ readonly teamId: TeamId; readonly userId: UserId }>
      readonly invites: ReadonlyArray<TeamInvite>
    }) => Effect.Effect<void, RepoError | TeamNumberConflict>
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
    // Task 5: roster copy 用途。contest スコープの全 team_invites を返す。
    // 小規模(数チーム × 数十招待)前提なのでページングなし。
    readonly listByContest: (
      contestId: ContestId
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
    readonly listByTeam: (
      contestId: ContestId,
      teamId: TeamId
    ) => Effect.Effect<ReadonlyArray<Instance>, RepoError>
    readonly findById: (id: InstanceId) => Effect.Effect<Option.Option<Instance>, RepoError>
    readonly create: (i: Instance) => Effect.Effect<Instance, RepoError | DuplicateInstanceIndex>
    // Task 8: readiness の previous_cleanup / beginContestPreparation 前検査で
    // 参照する。指定 Contest の全 Instance(全 status)を返す。
    readonly listByContest: (
      contestId: ContestId
    ) => Effect.Effect<ReadonlyArray<Instance>, RepoError>
    // Task 8: 「creating または deleting な Instance がグローバルに存在するか」の
    // 単発判定。beginContestPreparation の transitional_instance ガードが使う。
    readonly hasTransitional: Effect.Effect<boolean, RepoError>
    readonly remove: (id: InstanceId) => Effect.Effect<void, RepoError>
    readonly createIfAllowed: (
      i: Instance,
      quota: number,
      lock?: { readonly owningOperationId: Option.Option<OperationId> }
    ) => Effect.Effect<Instance, RepoError | QuotaExceeded | ProvisionInProgress | DuplicateInstanceIndex | OperationInProgress>
    readonly beginDeletingIfAllowed: (
      instanceId: InstanceId,
      now: number,
      lock?: { readonly owningOperationId: Option.Option<OperationId> }
    ) => Effect.Effect<Option.Option<Instance>, RepoError | OperationInProgress>
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
    // insertIfAllowed の NOT EXISTS は (contest_id, team_id, purpose) スコープ
    // なので queued rehearsal は competition enqueue を阻害しないが、
    // dequeueNextQueued は running phase では purpose='competition' しか拾わない
    // ため、放置すると orphan として queued に残り dashboard / 履歴 UI を汚す。
    // Task 10 の guarded_start Operation が正式化されたらこの port は不要になる予定。
    readonly cancelQueuedRehearsalsForContest: (contestId: ContestId) => Effect.Effect<void, RepoError>
    // Task 11 (finalize): finalizing 遷移直後の finish Operation が
    // 「新規 competition ジョブが積まれない」状態を確保するために、queued な
    // competition/rehearsal を一括で canceled に落とす。返り値は cancel した件数
    // (可観測性のため; 0 は「既に drained」の意)。
    readonly cancelQueuedByContest: (
      contestId: ContestId,
      now: number
    ) => Effect.Effect<number, RepoError>
    // Task 11 (finalize): drain step が「まだ running な bench_jobs があるか」を
    // 判定するために使う。purpose を分けず contest スコープの running 総数
    // (rehearsal は preparing 時点で存在しない想定だが、防御的に両者を含める)。
    readonly countRunningByContest: (contestId: ContestId) => Effect.Effect<number, RepoError>
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
    // Task 10: readiness の rehearsal key が使う。指定 Contest スコープで
    // status='finished' AND passed=1 AND purpose='rehearsal' の件数を返す。
    // 0 件なら「まだ疎通実証されていない」= start required で fail に落とす。
    readonly countSuccessfulRehearsals: (contestId: ContestId) => Effect.Effect<number, RepoError>
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

// RunnerConfig: bench job のタイムアウト + Task 10 で追加した runner heartbeat の
// 「stale と見なすまでの猶予」。readiness の runner check と start Operation は
// この閾値を使う(env 未指定時の既定は spec §readiness の RUNNER_MAX_AGE_MILLIS)。
export class RunnerConfig extends Context.Tag("app/RunnerConfig")<
  RunnerConfig,
  {
    readonly jobTimeoutMillis: number
    readonly maxAgeMillis: number
  }
>() {}

// 認証まわりの設定(ADMIN_GITHUB_LOGINS 由来)。Layer は main.ts で
// Config から組み立てる(テストでは Layer.succeed で注入)。
export class AuthConfig extends Context.Tag("app/AuthConfig")<
  AuthConfig,
  { readonly adminGithubLogins: ReadonlyArray<string> }
>() {}

// Task 8: readiness aggregation および enter_contest_mode / return_normal_mode
// の Operation が使う「インフラ側の状態」まとめ。単発の inventory call で
// devvm/benchvm の VM inventory item + template 存在 + team slot 集合 +
// isolation service 状態 + ノード空き RAM を返す。
export interface VmInventoryItem {
  readonly vmid: number
  readonly name: string
  readonly status: "running" | "stopped"
  readonly memoryBytes: number
  readonly onBoot: boolean
}

export interface ProxmoxInfrastructureInventory {
  readonly nodeFreeMemBytes: number
  readonly templateExists: boolean
  readonly devvm: VmInventoryItem
  readonly benchvm: VmInventoryItem
  readonly preparedTeamNumbers: ReadonlyArray<number>
  readonly isolationServiceActive: boolean
}

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
    // Task 7: reconciliation 向け inventory。qemu 一覧を叩き、name が
    // `^inucon-team[0-9]+-[0-9]+$` に一致する VM のみを返す(template や
    // devvm/benchvm 等は絶対に混ぜない)。memoryBytes は maxmem(config 上限)
    // を採用し、可用性計算とは別関心とする(runtime free は getNodeFreeMemBytes)。
    readonly listManagedVms: Effect.Effect<ReadonlyArray<{
      readonly vmid: number
      readonly name: string
      readonly status: "running" | "stopped"
      readonly memoryBytes: number
    }>, ProxmoxError>

    // Task 8: readiness / enter_contest_mode 用の集約 inventory。単一呼び出しで
    // 「readiness / mode transition が判断に必要とする現状」をすべて返す。
    // - nodeFreeMemBytes: Proxmox /nodes/:node/status memory.free(reclaimable
    //   page cache を含まないため /proc/meminfo MemAvailable より保守的)。
    // - templateExists: `templateVmid` (spec §Contest では 9100) が qemu 一覧に
    //   template=1 で存在するか。
    // - devvm/benchvm: 名前で解決した VM inventory item。onBoot は Proxmox の
    //   qemu/:vmid/config の onboot(0/1)を boolean に畳んだもの。
    // - preparedTeamNumbers: 「node network で iface=teamN として up している」
    //   かつ「benchvm の VM config の bridge にも teamN が入っている」bridge の
    //   N の集合(intersection)。片方だけでは実運用できないため必ず積集合を取る。
    // - isolationServiceActive: `inucon-team-isolation` service の state が
    //   running のときのみ true。inactive/failed/未定義はすべて false。
    readonly getInfrastructureInventory: Effect.Effect<ProxmoxInfrastructureInventory, ProxmoxError>

    // Task 8: enter_contest_mode / return_normal_mode 用の power / config primitive。
    // enter_contest_mode は「devvm (9300) を graceful shutdown → benchvm (9200)
    // を起動」する。force stop は絶対に呼ばない(guest shutdown が timeout に
    // 達したら ModeTransitionTimeout として blocked へ落とし、operator 判断待ち)。
    readonly setVmOnBoot: (vmid: number, enabled: boolean) => Effect.Effect<void, ProxmoxError>
    readonly shutdownVm: (vmid: number) => Effect.Effect<void, ProxmoxError>
    readonly waitForVmStatus: (
      vmid: number,
      status: "running" | "stopped",
      timeoutMillis: number
    ) => Effect.Effect<void, ProxmoxError | ModeTransitionTimeout>
    // Task 8 note: startVm は既存の signature を再利用する(実装は mode 側
    // credential で叩く)。互換のため port method の追加は行わない。
  }
>() {}

// Cloudflare API(DNS / Tunnel remote config / Access)。Phase 1-2 の runbook
// (ダッシュボード手動運用)実績の API 化。すべて冪等(ensure/remove)。
export class CloudflarePort extends Context.Tag("app/CloudflarePort")<
  CloudflarePort,
  {
    // Task 9: DNS CNAME(→ benchvm tunnel)+ tunnel ingress(ssh://ip:22)の追加/更新。
    // 成功時に upsert された CNAME の dnsRecordId を返す — 呼び出し元はこれを
    // ResourceBinding.externalId に載せ、reconciliation/cleanup が「portal が
    // 作ったこの 1 件」を狙って落とせるようにする(重複を勝手に消さない)。
    readonly ensureInstanceRoute: (args: {
      hostname: string
      ip: string
    }) => Effect.Effect<{ readonly dnsRecordId: string }, CloudflareError>
    readonly removeInstanceRoute: (hostname: string) => Effect.Effect<void, CloudflareError>
    // Task 9: 「Contest スコープの現メンバー ∪ 招待中」の email 集合と Access
    // policy include(email) を完全一致させる(exact set)。Phase 3 の「和集合
    // PUT」を置き換える:
    // - 過去エディションの email は残さない(spec §Global Constraints:
    //   「Access allow policy は当該 Contest Team の正確な email 集合へ
    //   収束させ、過去開催の email と和集合にしない」)。
    // - 呼び出し元が集める desired = members(email present) ∪ pending
    //   team_invites(email) の union は現 Contest 内でのみ許容する。
    // - emails は正規化(trim + lowercase + dedupe + sort)して include に載せる。
    // - 既存 app のポリシー形状が portal 所有シェイプ(単一 allow policy かつ
    //   include が email のみ)でないとき、上書きせず AmbiguousAccessPolicy を
    //   返し、operator 判断(手動整理)を要求する。
    // - 新規 app 作成時 emails=[] のときはポリシーを作らない(空 include は CF
    //   400、Task 7 実機検出)。既存 app + portal 所有 allow policy + emails=[]
    //   のときは policy を削除する(deny-by-default)。どちらの経路でも
    //   policyId は null を返す。
    readonly ensureAccessAppExact: (args: {
      hostname: string
      emails: ReadonlyArray<string>
    }) => Effect.Effect<
      { readonly appId: string; readonly policyId: string | null },
      CloudflareError | AmbiguousAccessPolicy
    >
    readonly removeAccessApp: (hostname: string) => Effect.Effect<void, CloudflareError>
    // Task 7: reconciliation 向け inventory。DNS / tunnel ingress / Access app /
    // policies を横断して読み、hostname prefix が `inucon-team\d+-\d+` の
    // resource だけを stem(FQDN の先頭ラベル)にまとめて返す。生 email は
    // 絶対に返さない — Access policy の include(email) は sorted+normalized
    // (小文字化)後に SHA-256 のみを返す(spec §credential:「Access email
    // 一覧を operation log / response に残さない」)。
    readonly getInstanceInventory: Effect.Effect<{
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
    }, CloudflareError>

    // Task 8: Cloudflare API token の verify を単発で行う readiness 用 probe。
    // GET /user/tokens/verify が active を返せば success、それ以外(status
    // が active でない / HTTP エラー / ネットワーク失敗)は CloudflareError で
    // 失敗する。readiness の `cloudflare_token` key が使う。
    //
    // review round 1 finding 3: 以前は返却型に inventoryReadable: true を
    // 含めていたが、実装は inventory を読んでおらず「常に true」の misleading な
    // フラグだった。readiness の `cloudflare_inventory` key は
    // getInstanceInventory を独立に呼ぶので、probe の責務は「token だけ」に
    // 揃える。API-Tokens-Read 権限は発行しない — 既発行トークンの verify のみ。
    readonly probe: Effect.Effect<
      { readonly tokenStatus: "active" },
      CloudflareError
    >
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

// Task 6: Operation の永続化 + atomic transition。単一 unfinished ロックは
// operations テーブルの partial unique index が最終的な強制点、cross-lock
// (creating/deleting Instance 中は enqueue 拒否)は enqueue の SQL に埋め込む。
export class OperationRepo extends Context.Tag("app/OperationRepo")<
  OperationRepo,
  {
    // Task 8: readiness / beginContestPreparation ガード用の「未完了 Operation が
    // 全体に 1 件でも存在するか」の単発判定。単一 operation 不変条件を守るために
    // 楽観ロック的に確認するので、返り値は boolean のみ(件数や list は返さない)。
    readonly hasUnfinished: Effect.Effect<boolean, RepoError>
    // Task 12: scheduler が `revoke_access` / `cleanup` を「同一 Contest かつ
    // 同一 kind の未完了 (queued/running/blocked/failed) Operation」が既にあれば
    // 再 enqueue しないための guard。plan spec §Step 3/4 の
    //   NOT EXISTS (SELECT 1 FROM operations WHERE contest_id=? AND kind=?
    //    AND status IN ('queued','running','blocked','failed'))
    // と同じ predicate。unique index は「globally 1 unfinished」しか強制しない
    // ため、per-(contest, kind) の再 enqueue 抑止はこの述語で明示的に行う。
    readonly hasUnfinishedByContestAndKind: (
      contestId: ContestId,
      kind: Operation["kind"]
    ) => Effect.Effect<boolean, RepoError>
    readonly enqueue: (
      input: NewOperation
    ) => Effect.Effect<Operation, RepoError | OperationInProgress>
    readonly findById: (id: OperationId) => Effect.Effect<Option.Option<Operation>, RepoError>
    readonly listSteps: (id: OperationId) => Effect.Effect<ReadonlyArray<OperationStep>, RepoError>
    // Task 13: ContestAdmin の Operations タブ用一覧。createdAt DESC + limit。
    // limit を明示 number で受け取り、境界層で default 20 / max 100 にクランプする。
    readonly listByContest: (
      contestId: ContestId,
      limit: number
    ) => Effect.Effect<ReadonlyArray<Operation>, RepoError>
    // claimNext: 「次に走らせるべき Step」を 1 件返す。同一 Operation で running
    // 中の Step があればスキップ、retry_at <= now、lease 未取得 or 期限切れの
    // queued Step のうち最も低 ordinal を lease する。attempt を +1 し、
    // running に遷移させる。
    readonly claimNext: (now: number) => Effect.Effect<Option.Option<OperationStep>, RepoError>
    readonly completeStep: (
      stepId: OperationStepId,
      summary: string,
      now: number
    ) => Effect.Effect<void, RepoError>
    readonly failStep: (
      stepId: OperationStepId,
      error: SanitizedOperationError,
      retryAt: Option.Option<number>,
      now: number
    ) => Effect.Effect<void, RepoError>
    readonly blockStep: (
      stepId: OperationStepId,
      error: SanitizedOperationError,
      now: number
    ) => Effect.Effect<void, RepoError>
    // Task 9: batch prepare Operation の「KSM settle 待ち」用に、running step の
    // progress_json を上書きする。retry ループで進捗(first low-memory
    // observation の時刻など)を DB に残し、worker 再起動後の同 step も同じ
    // 判断が続けられるようにする。書き込むのは step が running のときだけで、
    // 他状態への遷移は起こさない(status を触らない)。
    readonly updateStepProgress: (
      stepId: OperationStepId,
      progressJson: string
    ) => Effect.Effect<void, RepoError>
    // resumeExpired: cutoff 以前に lease_expires_at を持つ running Step を queued に戻す。
    // ワーカー起動時 (restart 補償) と定期スイープの両方から呼ばれる。返り値は
    // 実際に回収した Step 数(可観測性のため)。
    readonly resumeExpired: (cutoff: number) => Effect.Effect<number, RepoError>
    readonly retry: (
      operationId: OperationId,
      now: number
    ) => Effect.Effect<Operation, RepoError | InvalidOperationTransition>
    readonly cancel: (
      operationId: OperationId,
      now: number
    ) => Effect.Effect<Operation, RepoError | InvalidOperationTransition>
  }
>() {}

export class ResourceBindingRepo extends Context.Tag("app/ResourceBindingRepo")<
  ResourceBindingRepo,
  {
    readonly upsert: (binding: ResourceBinding) => Effect.Effect<void, RepoError>
    readonly listByContest: (
      contestId: ContestId
    ) => Effect.Effect<ReadonlyArray<ResourceBinding>, RepoError>
    readonly deleteById: (id: ResourceBindingId) => Effect.Effect<void, RepoError>
  }
>() {}

// Task 11: ArtifactRepo は contest_artifacts 行の正のリポジトリ。
// - upsert: (contest_id, kind) UNIQUE 上書き。finish/backup Operation の
//   artifact step が使う(regenerate は in-place 差し替え)。
// - listByContest: 監査/公開 API 用。生 storagePath は含む(handler が
//   境界で剥がす契約)。
// - findByKind / findById: 個別解決。download handler は必ず ArtifactRepo
//   経由で storagePath を得る(request path traversal 対策)。
// - markVerified: off_host_status='verified' + verified_at。checksum 判定は
//   application 層(finalization.ts)で行う。
export class ArtifactRepo extends Context.Tag("app/ArtifactRepo")<
  ArtifactRepo,
  {
    readonly upsert: (artifact: Artifact) => Effect.Effect<void, RepoError>
    readonly listByContest: (contestId: ContestId) => Effect.Effect<ReadonlyArray<Artifact>, RepoError>
    readonly findByKind: (
      contestId: ContestId,
      kind: Artifact["kind"]
    ) => Effect.Effect<Option.Option<Artifact>, RepoError>
    readonly findById: (id: ArtifactId) => Effect.Effect<Option.Option<Artifact>, RepoError>
    readonly markVerified: (id: ArtifactId, now: number) => Effect.Effect<void, RepoError>
  }
>() {}

// Task 10: runner_agents は runner heartbeat (poll payload) を反映する。
// touch は upsert 相当だが「別 runner id が混入したら別行になる」自然な
// upsert 契約を明示するため rename した(spec の RunnerAgentRepo.touch)。
// getFresh は「now - lastSeenAt <= maxAgeMillis の直近 1 件」を返す。複数
// runner が並走した場合は最新 heartbeat の 1 台を採る(現運用は runner=1 台前提)。
export class RunnerAgentRepo extends Context.Tag("app/RunnerAgentRepo")<
  RunnerAgentRepo,
  {
    readonly touch: (agent: {
      readonly id: string
      readonly revision: string
      readonly benchReady: boolean
      readonly healthSummary: string
      readonly lastSeenAt: number
    }) => Effect.Effect<void, RepoError>
    readonly getFresh: (
      now: number,
      maxAgeMillis: number
    ) => Effect.Effect<
      Option.Option<{
        readonly id: string
        readonly revision: string
        readonly benchReady: boolean
        readonly healthSummary: string
        readonly lastSeenAt: number
      }>,
      RepoError
    >
    readonly listAll: Effect.Effect<
      ReadonlyArray<{
        readonly id: string
        readonly revision: string
        readonly benchReady: boolean
        readonly healthSummary: string
        readonly lastSeenAt: number
      }>,
      RepoError
    >
  }
>() {}

// Task 10: portal DB 以外の backup 用ストレージへの書き込み可否 probe。
// Live 実装 (better-sqlite3) は canary create/fsync/delete でルート
// (BACKUP_PATH) が directory + writable であることを確認する。readiness の
// backup check と Task 11 の snapshot API が同じポートを共有する。
export class BackupError extends Data.TaggedError("BackupError")<{
  readonly reason:
    | "path_missing"
    | "path_not_directory"
    | "not_writable"
    | "canary_failed"
    | "not_configured"
    // Task 11: snapshot / writeArtifact / readArtifact 系の追加理由。
    // すべて BackupError で一様に扱い、上位は operation_step の
    // sanitized error に storage_unavailable として集約する。
    | "source_missing"
    | "destination_exists"
    | "destination_outside_root"
    | "io_error"
  readonly detail: string
}> {}

// Task 11: BackupPort は artifact 書き込み/読み出しの唯一の I/O 境界。
// - probe: readiness / 起動時 canary(既存)。
// - createSnapshot: better-sqlite3 の online backup で portal DB を
//   `/backups/contests/<contestId>/e<edition>/snapshot.sqlite` に書き出し、
//   終了後に SHA-256 を計算して返す。
// - writeArtifact: scoreboard.json / .csv の bytes を書き込む(kind 別に
//   ファイル名を固定; server-generated path)。
// - readArtifact: download handler が ArtifactRepo で解決した storagePath を
//   受けて bytes を返す。関数内で resolve(root) startsWith 判定を行い、
//   root 外への path traversal を絶対に許さない。
export interface ArtifactWriteResult {
  readonly storagePath: string
  readonly sha256: string
  readonly sizeBytes: number
}

export class BackupPort extends Context.Tag("app/BackupPort")<
  BackupPort,
  {
    readonly probe: Effect.Effect<void, BackupError>
    readonly createSnapshot: (args: {
      readonly contestId: ContestId
      readonly edition: number
      readonly now: number
    }) => Effect.Effect<ArtifactWriteResult, BackupError>
    readonly writeArtifact: (args: {
      readonly contestId: ContestId
      readonly edition: number
      readonly now: number
      readonly kind: "scoreboard" | "scoreboard_csv"
      readonly bytes: Uint8Array
    }) => Effect.Effect<ArtifactWriteResult, BackupError>
    readonly readArtifact: (storagePath: string) => Effect.Effect<Uint8Array, BackupError>
  }
>() {}

// OperationHandler の実装は provider Layer に依存する(Task 7 以降で埋まる)。
// 登録済みハンドラは (kind, stepKey) で lookup する。存在しないハンドラは
// worker が「configuration_error」相当で step を blocked にする。
export interface OperationHandler {
  readonly run: (step: OperationStep) => Effect.Effect<StepOutcome, OperationExecutionError>
}

export class OperationHandlerRegistry extends Context.Tag("app/OperationHandlerRegistry")<
  OperationHandlerRegistry,
  {
    readonly lookup: (
      kind: Operation["kind"],
      stepKey: string
    ) => Option.Option<OperationHandler>
  }
>() {}

// OperationWorker の tick / retry 動作の設定(Config から組み立てる)。
export class OperationWorkerConfig extends Context.Tag("app/OperationWorkerConfig")<
  OperationWorkerConfig,
  {
    readonly pollIntervalMillis: number
    readonly retryBaseMillis: number
    readonly retryMaxMillis: number
    readonly maxAttempts: number
    readonly leaseDurationMillis: number
  }
>() {}

// Task 7 review round 3 #2: hostname → FQDN の zone suffix を env に外出しする。
// 従来は reconciliation.ts / usecases/provisioning.ts に `kisen.one` を hard-code
// していたが、zone を切替えたときに片方だけ古い suffix を使い続けて silent
// no-op を起こす事故があった。`CF_ZONE_NAME` を single source of truth にする。
export class HostnameConfig extends Context.Tag("app/HostnameConfig")<
  HostnameConfig,
  {
    readonly zoneName: string
  }
>() {}
