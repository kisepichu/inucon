import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity
} from "@effect/platform"
import { Context, Schema } from "effect"
import {
  BenchJob,
  BenchJobDetail,
  BenchJobId,
  BenchJobStatus,
  Contest,
  ContestDraftPatch,
  ContestId,
  ContestStatus,
  ContestTransitionRequest,
  CopyContestRosterRequest,
  CreateContestDraftRequest,
  CreateInstanceRequest,
  CreateTeamInstanceRequest,
  CreateTeamRequest,
  EnqueueBenchRequest,
  Instance,
  InstanceId,
  InstanceStatus,
  InviteRequest,
  InviteResult,
  JobAction,
  Me,
  Operation,
  PollJobResponse,
  ReconciliationApplyRequest,
  ReconciliationPlan,
  ReconciliationPlanRequest,
  RunnerFinishRequest,
  RunnerProgressRequest,
  ScoreboardEntry,
  SetTeamMembersRequest,
  Team,
  TeamId,
  TeamInvite,
  TeamWithMembers,
  UpdateContestDraftRequest,
  User
} from "./schemas.js"

// --- cookie 名(ポータルのハンドラ/ミドルウェアと契約側で共有する) ---

export const SESSION_COOKIE = "inucon_session"
export const STATE_COOKIE = "inucon_oauth_state"

// --- HTTP 境界のエラー(Schema.TaggedError + status 注釈) ---

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  {},
  HttpApiSchema.annotations({ status: 401 })
) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  {},
  HttpApiSchema.annotations({ status: 403 })
) {}

// OAuth callback の state 不一致/欠落(login CSRF 対策)。
export class InvalidOAuthState extends Schema.TaggedError<InvalidOAuthState>()(
  "InvalidOAuthState",
  {},
  HttpApiSchema.annotations({ status: 400 })
) {}

// GitHub とのコード交換/ユーザー取得の失敗(上流エラー)。
export class OAuthExchangeFailed extends Schema.TaggedError<OAuthExchangeFailed>()(
  "OAuthExchangeFailed",
  {},
  HttpApiSchema.annotations({ status: 502 })
) {}

// URL の :id が指す行が無い(コンテスト未作成 / チーム不存在など)。
export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  {},
  HttpApiSchema.annotations({ status: 404 })
) {}

// POST /api/teams: teamNumber の重複(DB UNIQUE 制約違反をマップ)。
export class TeamNumberConflict extends Schema.TaggedError<TeamNumberConflict>()(
  "TeamNumberConflict",
  { teamNumber: Schema.Int },
  HttpApiSchema.annotations({ status: 409 })
) {}

// PUT /api/teams/:id/members: 未ログイン(users に不在)の githubLogin。
export class UnknownGithubLogins extends Schema.TaggedError<UnknownGithubLogins>()(
  "UnknownGithubLogins",
  { logins: Schema.Array(Schema.String) },
  HttpApiSchema.annotations({ status: 422 })
) {}

// PUT /api/teams/:id/members: 既に他チームに所属しているユーザーが含まれる
// (setMembers の全量置換で横取りしないよう、黙って無視せず 409 で返す)。
export class MemberConflict extends Schema.TaggedError<MemberConflict>()(
  "MemberConflict",
  { logins: Schema.Array(Schema.String) },
  HttpApiSchema.annotations({ status: 409 })
) {}

// POST /api/instances: privateIp がチームサブネット外(domain の
// validateBenchTarget をマップ)。
export class TargetIpOutOfSubnet extends Schema.TaggedError<TargetIpOutOfSubnet>()(
  "TargetIpOutOfSubnet",
  { ip: Schema.String, teamNumber: Schema.Int },
  HttpApiSchema.annotations({ status: 422 })
) {}

// POST /api/instances: 同一チーム内で index が重複(DB UNIQUE (team_id, idx)
// 制約違反をマップ。TeamNumberConflict と同様の理由で 409)。
export class DuplicateInstanceIndex extends Schema.TaggedError<DuplicateInstanceIndex>()(
  "DuplicateInstanceIndex",
  { teamId: TeamId, index: Schema.Int.pipe(Schema.positive()) },
  HttpApiSchema.annotations({ status: 409 })
) {}

// POST /api/teams/:id/instances(追加ボタン): 該当チームの creating+running 数
// が既に Contest.instanceQuota 以上(スペック §Instance 集約 不変条件1。
// portal/src/application/errors.ts の QuotaExceeded をマップ)。
export class QuotaExceeded extends Schema.TaggedError<QuotaExceeded>()(
  "QuotaExceeded",
  { teamId: TeamId, quota: Schema.Int },
  HttpApiSchema.annotations({ status: 409 })
) {}

// POST /api/teams/:id/instances: 該当チームに進行中(creating/deleting)の
// オーケストレーションが既にある(スペック §Instance 集約 不変条件2、連打・
// 競合防止。application の ProvisionInProgress をマップ)。
export class ProvisionInProgress extends Schema.TaggedError<ProvisionInProgress>()(
  "ProvisionInProgress",
  { teamId: TeamId },
  HttpApiSchema.annotations({ status: 409 })
) {}

// POST /api/teams/:id/instances: eevee の空き RAM が閾値未満(spike メモ
// §リスク4。application の InsufficientMemory をマップ)。DuplicateInstanceIndex
// 等の DB 競合系(409)とは異なり、外部リソース制約による処理不能なので
// TargetIpOutOfSubnet と同様 422 にする。
export class InsufficientMemory extends Schema.TaggedError<InsufficientMemory>()(
  "InsufficientMemory",
  { freeBytes: Schema.Int, requiredBytes: Schema.Int },
  HttpApiSchema.annotations({ status: 422 })
) {}

// DELETE /api/teams/:id/instances/:instanceId: 削除対象の privateIp を
// targetIp とする BenchJob が queued/running(スペック §Instance 集約
// 不変条件4、ベンチ対象の消失防止。application の InstanceInUse をマップ)。
export class InstanceInUse extends Schema.TaggedError<InstanceInUse>()(
  "InstanceInUse",
  { instanceId: InstanceId },
  HttpApiSchema.annotations({ status: 409 })
) {}

// POST /api/bench-jobs: instanceId 指定時、対象 Instance が running でない
// (Task 6 レビュー #3、application の InstanceNotRunning をマップ)。
// InstanceInUse と同じ「Instance の現在状態に起因する 409」なので同じ status。
export class InstanceNotRunning extends Schema.TaggedError<InstanceNotRunning>()(
  "InstanceNotRunning",
  { instanceId: InstanceId },
  HttpApiSchema.annotations({ status: 409 })
) {}

// DELETE /api/teams/:id/instances/:instanceId: running/failed 以外からの削除
// 要求(domain の beginDeleting をマップ。InvalidJobTransition と同じ形)。
export class InvalidInstanceTransition extends Schema.TaggedError<InvalidInstanceTransition>()(
  "InvalidInstanceTransition",
  { instanceId: InstanceId, from: InstanceStatus, to: InstanceStatus },
  HttpApiSchema.annotations({ status: 409 })
) {}

// POST /api/admin/contest/{start,finish}: 不正な状態遷移(domain の
// startContest/finishContest をマップ)。
export class InvalidContestTransition extends Schema.TaggedError<InvalidContestTransition>()(
  "InvalidContestTransition",
  { from: ContestStatus, to: ContestStatus },
  HttpApiSchema.annotations({ status: 409 })
) {}

// Task 5: draft wizard の schedule バリデーション(未設定/順序違反)。
export class InvalidContestSchedule extends Schema.TaggedError<InvalidContestSchedule>()(
  "InvalidContestSchedule",
  {
    reason: Schema.Literal(
      "missing_schedule",
      "start_not_before_end",
      "access_close_before_end",
      "cleanup_before_access_close"
    )
  },
  HttpApiSchema.annotations({ status: 422 })
) {}

// Task 5: 新規 Contest 作成の edition 部分ユニーク違反(canceled は焼かない)。
export class ContestEditionConflict extends Schema.TaggedError<ContestEditionConflict>()(
  "ContestEditionConflict",
  { edition: Schema.Int },
  HttpApiSchema.annotations({ status: 409 })
) {}

// Task 5: 楽観ロック競合。actual を載せて UI が再取得できるようにする。
export class ContestRevisionConflict extends Schema.TaggedError<ContestRevisionConflict>()(
  "ContestRevisionConflict",
  { expected: Schema.Int, actual: Schema.Int },
  HttpApiSchema.annotations({ status: 409 })
) {}

// Task 5: 単一 operational Contest 制約違反。
export class OperationalContestConflict extends Schema.TaggedError<OperationalContestConflict>()(
  "OperationalContestConflict",
  {},
  HttpApiSchema.annotations({ status: 409 })
) {}

// Task 7: reconciliation apply の失敗マッピング。
// - StaleReconciliationPlan: plan digest / inventory が古い(409、UI は再取得)。
// - AmbiguousReconciliation: 分類が blocked を含む(422、operator adopt 待ち)。
export class StaleReconciliationPlan extends Schema.TaggedError<StaleReconciliationPlan>()(
  "StaleReconciliationPlan",
  {},
  HttpApiSchema.annotations({ status: 409 })
) {}

export class AmbiguousReconciliation extends Schema.TaggedError<AmbiguousReconciliation>()(
  "AmbiguousReconciliation",
  { hostnames: Schema.Array(Schema.String) },
  HttpApiSchema.annotations({ status: 422 })
) {}

// Task 7 review #2: 「plan は正当だが actionable が 0 件」= 既に clean な状態は
// AmbiguousReconciliation(422) と混同されるため、専用の 409 エラーで区別する。
export class NothingToReconcile extends Schema.TaggedError<NothingToReconcile>()(
  "NothingToReconcile",
  {},
  HttpApiSchema.annotations({ status: 409 })
) {}

// Task 7 review round 3 #1: 上流 provider (Proxmox / Cloudflare) の失敗を
// 500 defect にせず、明示的に 503 でマップする。UI は「provider 一時障害、
// 数分後に再試行」と示せる。details.provider は "proxmox" / "cloudflare"。
export class ProviderUnavailable extends Schema.TaggedError<ProviderUnavailable>()(
  "ProviderUnavailable",
  { provider: Schema.Literal("proxmox", "cloudflare") },
  HttpApiSchema.annotations({ status: 503 })
) {}

// POST /api/bench-jobs: Contest が running でない(domain の
// checkEnqueueAllowed をマップ)。
export class ContestNotRunning extends Schema.TaggedError<ContestNotRunning>()(
  "ContestNotRunning",
  { status: ContestStatus },
  HttpApiSchema.annotations({ status: 409 })
) {}

// POST /api/bench-jobs: 自チームに既に queued/running のジョブがある
// (連打防止。スペック §BenchJob 不変条件 1)。
export class TeamJobAlreadyQueued extends Schema.TaggedError<TeamJobAlreadyQueued>()(
  "TeamJobAlreadyQueued",
  { teamId: TeamId },
  HttpApiSchema.annotations({ status: 409 })
) {}

// POST /api/bench-jobs/:id/cancel: running のジョブはキャンセルできない
// (Phase 2 では実行中断をサポートしないため)。
export class CannotCancelRunning extends Schema.TaggedError<CannotCancelRunning>()(
  "CannotCancelRunning",
  { jobId: BenchJobId },
  HttpApiSchema.annotations({ status: 409 })
) {}

// POST /api/runner/jobs/:id/{progress,finish}: ジョブが running でない状態
// での報告(二重 poll・タイムアウト後の遅延報告など)。POST
// /api/bench-jobs/:id/cancel が queued 以外(finished/canceled/failed)を
// 指した場合もここに乗る。
export class InvalidJobTransition extends Schema.TaggedError<InvalidJobTransition>()(
  "InvalidJobTransition",
  { jobId: BenchJobId, from: BenchJobStatus, action: JobAction },
  HttpApiSchema.annotations({ status: 409 })
) {}

// --- 認証ミドルウェア(契約側は Tag のみ。実装 Layer は portal 側) ---

// ミドルウェアはエンドポイント定義に .middleware() で載せる必要があるため、
// Tag と CurrentUser は契約(shared)側に置く。実装は
// portal/src/infrastructure/http/middleware.ts。

export class CurrentUser extends Context.Tag("CurrentUser")<CurrentUser, User>() {}

const sessionCookie = HttpApiSecurity.apiKey({ in: "cookie", key: SESSION_COOKIE })

export class Authentication extends HttpApiMiddleware.Tag<Authentication>()("Authentication", {
  failure: Unauthorized,
  provides: CurrentUser,
  security: { session: sessionCookie }
}) {}

export class AdminOnly extends HttpApiMiddleware.Tag<AdminOnly>()("AdminOnly", {
  failure: Schema.Union(Unauthorized, Forbidden),
  provides: CurrentUser,
  security: { session: sessionCookie }
}) {}

export class RunnerAuth extends HttpApiMiddleware.Tag<RunnerAuth>()("RunnerAuth", {
  failure: Unauthorized,
  security: { bearer: HttpApiSecurity.bearer }
}) {}

// --- グループ定義 ---

export const healthGroup = HttpApiGroup.make("health").add(
  HttpApiEndpoint.get("getHealth", "/api/health").addSuccess(
    Schema.Struct({ status: Schema.Literal("ok") })
  )
)

// リダイレクト系(/auth/github, /auth/github/callback)も HttpApi で表現する
// (スパイク結果: portal/src/infrastructure/http/README.md。実装側は
// handleRaw で 302 + Set-Cookie を返す)。
export const authGroup = HttpApiGroup.make("auth")
  .add(HttpApiEndpoint.get("githubLogin", "/auth/github").addSuccess(HttpApiSchema.Empty(302)))
  .add(
    HttpApiEndpoint.get("githubCallback", "/auth/github/callback")
      // code / state はどちらも省略可能にし、欠落チェックはハンドラ側で行う。
      // こうしないと欠落時に Schema デコード失敗(400 だがボディが契約と
      // 無関係かつ state cookie 破棄も走らない)になってしまうため。
      // ハンドラは欠落を state 不一致と同じ 400(InvalidOAuthState)として
      // 扱い、state cookie を破棄する。
      .setUrlParams(
        Schema.Struct({ code: Schema.optional(Schema.String), state: Schema.optional(Schema.String) })
      )
      .addSuccess(HttpApiSchema.Empty(302))
      .addError(InvalidOAuthState)
      .addError(OAuthExchangeFailed)
  )
  .add(HttpApiEndpoint.get("me", "/api/me").addSuccess(Me).middleware(Authentication))
  .add(
    // logout はセッションが無効でも成功する(冪等)。Authentication は掛けない。
    HttpApiEndpoint.post("logout", "/api/auth/logout").addSuccess(HttpApiSchema.NoContent)
  )

// GET /api/contest(compat 公開): 現在表示すべきコンテスト(getDisplay)。
// Task 4: この単一 endpoint に加えて、明示 ID の archive API を contestsGroup へ
// 追加した。Web 側は Task 5 以降で contestsGroup に完全移行する。
export const contestGroup = HttpApiGroup.make("contest").add(
  HttpApiEndpoint.get("getContest", "/api/contest")
    .addSuccess(Contest)
    .addError(NotFound)
)

// GET /api/contests / /api/contests/:contestId / /api/contests/:contestId/scoreboard
// (公開 archive API、Task 4)。canceled は list/detail のいずれにも現れない
// (admin は Task 5 の contestAdminGroup で includeCanceled=true 経由で参照する)。
export const contestsGroup = HttpApiGroup.make("contests")
  .add(
    HttpApiEndpoint.get("listContests", "/api/contests")
      .addSuccess(Schema.Array(Contest))
  )
  .add(
    HttpApiEndpoint.get("getContestById")`/api/contests/${HttpApiSchema.param("contestId", ContestId)}`
      .addSuccess(Contest)
      .addError(NotFound)
  )
  .add(
    HttpApiEndpoint.get(
      "getContestScoreboard"
    )`/api/contests/${HttpApiSchema.param("contestId", ContestId)}/scoreboard`
      .addSuccess(Schema.Array(ScoreboardEntry))
      .addError(NotFound)
  )

export const teamsGroup = HttpApiGroup.make("teams")
  // 参照はセッションのみ(全チームのメンバー情報込みで返す)。
  .add(
    HttpApiEndpoint.get("listTeams", "/api/teams")
      .addSuccess(Schema.Array(TeamWithMembers))
      .middleware(Authentication)
  )
  // 作成は admin のみ。teamNumber 重複は 409。
  .add(
    HttpApiEndpoint.post("createTeam", "/api/teams")
      .setPayload(CreateTeamRequest)
      .addSuccess(Team)
      .addError(TeamNumberConflict)
      .middleware(AdminOnly)
  )
  // メンバー割当(全量置換)も admin のみ。
  .add(
    HttpApiEndpoint.put("setTeamMembers")`/api/teams/${HttpApiSchema.param("id", TeamId)}/members`
      .setPayload(SetTeamMembersRequest)
      .addSuccess(TeamWithMembers)
      .addError(NotFound)
      .addError(UnknownGithubLogins)
      .addError(MemberConflict)
      .middleware(AdminOnly)
  )

export const instancesGroup = HttpApiGroup.make("instances")
  // 参照は当該チームメンバー or admin(それ以外は Forbidden、403)。
  .add(
    HttpApiEndpoint.get("listTeamInstances")`/api/teams/${HttpApiSchema.param("id", TeamId)}/instances`
      .addSuccess(Schema.Array(Instance))
      .addError(NotFound)
      .addError(Forbidden)
      .middleware(Authentication)
  )
  // 登録は admin のみ。privateIp がチームサブネット外なら 422。
  .add(
    HttpApiEndpoint.post("createInstance", "/api/instances")
      .setPayload(CreateInstanceRequest)
      .addSuccess(Instance)
      .addError(NotFound)
      .addError(TargetIpOutOfSubnet)
      .addError(DuplicateInstanceIndex)
      .middleware(AdminOnly)
  )
  // 削除は admin のみ。logout と同様に冪等(存在しない id でも 204)。
  // これは Terraform 製 VM の台帳取り込み(POST /api/instances)と対になる
  // admin 専用の台帳操作経路であり、セルフサービス削除(deleteTeamInstance)
  // とは意味論が異なる(こちらは無条件・冪等、セルフサービスは状態ガード付き)。
  .add(
    HttpApiEndpoint.del("deleteInstance")`/api/instances/${HttpApiSchema.param("id", InstanceId)}`
      .addSuccess(HttpApiSchema.NoContent)
      .middleware(AdminOnly)
  )
  // 追加ボタン(当該チームメンバー or admin。スペック §HTTP API 差分)。
  // ガード(quota/進行中/RAM)通過で creating 行を返す(202 相当、以後は
  // ポーリングで反映)。
  .add(
    HttpApiEndpoint.post("createTeamInstance")`/api/teams/${HttpApiSchema.param("id", TeamId)}/instances`
      .setPayload(CreateTeamInstanceRequest)
      .addSuccess(Instance)
      .addError(NotFound)
      .addError(Forbidden)
      .addError(QuotaExceeded)
      .addError(ProvisionInProgress)
      .addError(InsufficientMemory)
      .addError(DuplicateInstanceIndex)
      .middleware(Authentication)
  )
  // 削除ボタン(当該チームメンバー or admin)。running/failed のみ受理し
  // deleting へ遷移させる(実処理はワーカーが引き継ぐ)。path の teamId は
  // URL 構造上の入れ子(GET/POST と同じ /api/teams/:id/instances 配下)の
  // ためだけに存在し、認可判定は instanceId から解決した実際の所属チームで
  // 行う(requestDeleteInstance が内部で解決するため teamId 自体は使わない)。
  // Task 6 レビュー #4: 対象自身は running/failed でも、同一チームの他の
  // インスタンスが既に creating/deleting なら ProvisionInProgress(409)。
  // createTeamInstance と同じ「進行中1本」ガード(スペック §Instance 集約
  // 不変条件2)を削除経路にも課す(既存の ProvisionInProgress を再利用)。
  .add(
    HttpApiEndpoint.del(
      "deleteTeamInstance"
    )`/api/teams/${HttpApiSchema.param("teamId", TeamId)}/instances/${HttpApiSchema.param("instanceId", InstanceId)}`
      .addSuccess(HttpApiSchema.NoContent)
      .addError(Forbidden)
      .addError(ProvisionInProgress)
      .addError(InstanceInUse)
      .addError(InvalidInstanceTransition)
      .middleware(Authentication)
  )

// コンテスト状態遷移(admin のみ)。不正遷移は domain の
// startContest/finishContest をマップした 409。
export const adminGroup = HttpApiGroup.make("admin")
  .add(
    HttpApiEndpoint.post("startContest", "/api/admin/contest/start")
      .addSuccess(Contest)
      .addError(NotFound)
      .addError(InvalidContestTransition)
      .middleware(AdminOnly)
  )
  .add(
    HttpApiEndpoint.post("finishContest", "/api/admin/contest/finish")
      .addSuccess(Contest)
      .addError(NotFound)
      .addError(InvalidContestTransition)
      .middleware(AdminOnly)
  )
  // 招待(admin。スペック §招待フロー): users にいれば即所属 + email 更新、
  // いなければ team_invites 作成。全 running インスタンスの Access/鍵を
  // 同期して 3 点の成否 + warning を返す。他チーム所属ユーザーは 409。
  .add(
    HttpApiEndpoint.post("inviteMember")`/api/admin/teams/${HttpApiSchema.param("id", TeamId)}/invites`
      .setPayload(InviteRequest)
      .addSuccess(InviteResult)
      .addError(NotFound)
      .addError(MemberConflict)
      .middleware(AdminOnly)
  )
  .add(
    HttpApiEndpoint.get("listInvites")`/api/admin/teams/${HttpApiSchema.param("id", TeamId)}/invites`
      .addSuccess(Schema.Array(TeamInvite))
      .addError(NotFound)
      .middleware(AdminOnly)
  )

// Task 5: /api/admin/contests: draft wizard 用の contest scoped 管理 API。
// - list は includeCanceled=true で canceled を返す監査経路も持つ
// - detail は canceled も 200 で返す(public /api/contests は 404 にする)
// - PATCH で expectedRevision + patch を受けて楽観ロック update
// - prepare/cancel は expectedRevision のみを受けて明示的な状態遷移
// - roster/copy は source contest から teams/members/invites を複製する
export const contestAdminGroup = HttpApiGroup.make("contestAdmin")
  .add(
    HttpApiEndpoint.get("listAdminContests", "/api/admin/contests")
      .setUrlParams(Schema.Struct({ includeCanceled: Schema.optional(Schema.String) }))
      .addSuccess(Schema.Array(Contest))
      .middleware(AdminOnly)
  )
  .add(
    HttpApiEndpoint.post("createContestDraft", "/api/admin/contests")
      .setPayload(CreateContestDraftRequest)
      .addSuccess(Contest)
      .addError(ContestEditionConflict)
      .addError(InvalidContestSchedule)
      .middleware(AdminOnly)
  )
  .add(
    HttpApiEndpoint.get("getAdminContest")`/api/admin/contests/${HttpApiSchema.param("contestId", ContestId)}`
      .addSuccess(Contest)
      .addError(NotFound)
      .middleware(AdminOnly)
  )
  .add(
    HttpApiEndpoint.patch("updateContestDraft")`/api/admin/contests/${HttpApiSchema.param("contestId", ContestId)}`
      .setPayload(UpdateContestDraftRequest)
      .addSuccess(Contest)
      .addError(NotFound)
      .addError(ContestRevisionConflict)
      .addError(InvalidContestTransition)
      .addError(InvalidContestSchedule)
      .middleware(AdminOnly)
  )
  .add(
    HttpApiEndpoint.post(
      "beginContestPreparation"
    )`/api/admin/contests/${HttpApiSchema.param("contestId", ContestId)}/prepare`
      .setPayload(ContestTransitionRequest)
      .addSuccess(Contest)
      .addError(NotFound)
      .addError(ContestRevisionConflict)
      .addError(OperationalContestConflict)
      .addError(InvalidContestTransition)
      .addError(InvalidContestSchedule)
      .middleware(AdminOnly)
  )
  .add(
    HttpApiEndpoint.post(
      "cancelAdminContest"
    )`/api/admin/contests/${HttpApiSchema.param("contestId", ContestId)}/cancel`
      .setPayload(ContestTransitionRequest)
      .addSuccess(Contest)
      .addError(NotFound)
      .addError(ContestRevisionConflict)
      .addError(InvalidContestTransition)
      .middleware(AdminOnly)
  )
  .add(
    HttpApiEndpoint.post(
      "copyContestRoster"
    )`/api/admin/contests/${HttpApiSchema.param("contestId", ContestId)}/roster/copy`
      .setPayload(CopyContestRosterRequest)
      .addSuccess(Schema.Array(Team))
      .addError(NotFound)
      .addError(InvalidContestTransition)
      .middleware(AdminOnly)
  )

// enqueue/cancel はチームメンバー(自チームのみ、ユースケース側で判定)。
// 一覧(スコア・状態)は全員可。詳細(ログ含む)は自チーム + admin のみ
// (ユースケース側で判定、他チームは Forbidden)。
export const benchGroup = HttpApiGroup.make("bench")
  .add(
    HttpApiEndpoint.post("enqueueBench", "/api/bench-jobs")
      .setPayload(EnqueueBenchRequest)
      .addSuccess(BenchJob)
      .addError(ContestNotRunning)
      .addError(TeamJobAlreadyQueued)
      .addError(TargetIpOutOfSubnet)
      .addError(Forbidden)
      .addError(NotFound)
      .addError(InstanceNotRunning)
      .middleware(Authentication)
  )
  .add(
    HttpApiEndpoint.get("listBenchJobs", "/api/bench-jobs")
      .setUrlParams(Schema.Struct({ teamId: TeamId }))
      .addSuccess(Schema.Array(BenchJob))
      .middleware(Authentication)
  )
  .add(
    HttpApiEndpoint.get("getBenchJob")`/api/bench-jobs/${HttpApiSchema.param("id", BenchJobId)}`
      .addSuccess(BenchJobDetail)
      .addError(Forbidden)
      .middleware(Authentication)
  )
  .add(
    HttpApiEndpoint.post("cancelBenchJob")`/api/bench-jobs/${HttpApiSchema.param("id", BenchJobId)}/cancel`
      .addSuccess(BenchJob)
      .addError(Forbidden)
      .addError(CannotCancelRunning)
      .addError(InvalidJobTransition)
      .middleware(Authentication)
  )

// GET /api/scoreboard(公開): チームごとの最新/ベストスコア一覧
// (BenchJobRepo.scoreboard をそのまま返す、Task 8)。
export const scoreboardGroup = HttpApiGroup.make("scoreboard").add(
  HttpApiEndpoint.get("getScoreboard", "/api/scoreboard")
    .addSuccess(Schema.Array(ScoreboardEntry))
)

// ランナー(benchvm 常駐)専用。RunnerAuth(shared token)で認可する。
export const runnerGroup = HttpApiGroup.make("runner")
  .add(
    HttpApiEndpoint.post("pollJob", "/api/runner/jobs/poll")
      .addSuccess(PollJobResponse)
      .middleware(RunnerAuth)
  )
  .add(
    HttpApiEndpoint.post("reportProgress")`/api/runner/jobs/${HttpApiSchema.param("id", BenchJobId)}/progress`
      .setPayload(RunnerProgressRequest)
      .addSuccess(HttpApiSchema.NoContent)
      .addError(InvalidJobTransition)
      .middleware(RunnerAuth)
  )
  .add(
    HttpApiEndpoint.post("reportFinish")`/api/runner/jobs/${HttpApiSchema.param("id", BenchJobId)}/finish`
      .setPayload(RunnerFinishRequest)
      .addSuccess(HttpApiSchema.NoContent)
      .addError(InvalidJobTransition)
      .middleware(RunnerAuth)
  )

// Task 7: reconciliation plan/apply (durable Operation) の admin API。
// AdminOnly。POST /plan は inventory 読み取り + 分類 + digest 計算のみで
// mutation 無し。POST /apply は planDigest + contestRevision + adoptHostnames
// を突き合わせ、パスすれば `reconcile` Operation を enqueue する。
// spec §Reconciliation: apply は「plan digest と Contest revision が現在値と
// 一致するときだけ受け付ける」「ambiguous は apply を block」。
export const operationsGroup = HttpApiGroup.make("operations")
  .add(
    HttpApiEndpoint.post(
      "planReconciliation"
    )`/api/admin/contests/${HttpApiSchema.param("contestId", ContestId)}/reconciliation/plan`
      .setPayload(ReconciliationPlanRequest)
      .addSuccess(ReconciliationPlan)
      .addError(NotFound)
      .addError(ProviderUnavailable)
      .middleware(AdminOnly)
  )
  .add(
    HttpApiEndpoint.post(
      "applyReconciliation"
    )`/api/admin/contests/${HttpApiSchema.param("contestId", ContestId)}/reconciliation/apply`
      .setPayload(ReconciliationApplyRequest)
      .addSuccess(Operation)
      .addError(NotFound)
      .addError(ProviderUnavailable)
      .addError(StaleReconciliationPlan)
      .addError(AmbiguousReconciliation)
      .addError(NothingToReconcile)
      .addError(OperationalContestConflict)
      .middleware(AdminOnly)
  )

export const api = HttpApi.make("inucon")
  .add(healthGroup)
  .add(authGroup)
  .add(contestGroup)
  .add(contestsGroup)
  .add(teamsGroup)
  .add(instancesGroup)
  .add(adminGroup)
  .add(contestAdminGroup)
  .add(benchGroup)
  .add(runnerGroup)
  .add(scoreboardGroup)
  .add(operationsGroup)
