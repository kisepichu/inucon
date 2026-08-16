// 境界 Schema(DTO)はここに集約する。後続タスクで追記していく。
//
// ID のブランドは portal/src/domain/ids.ts と同名(構造的ブランドなので相互に
// 代入可能)。portal のドメイン Schema.Class インスタンスはここの Struct 型に
// 構造的に代入できるため、ハンドラは変換なしでそのまま返せる。
import { Schema } from "effect"

export const UserId = Schema.String.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type

export const TeamId = Schema.String.pipe(Schema.brand("TeamId"))
export type TeamId = typeof TeamId.Type

export const ContestId = Schema.String.pipe(Schema.brand("ContestId"))
export type ContestId = typeof ContestId.Type

export const InstanceId = Schema.String.pipe(Schema.brand("InstanceId"))
export type InstanceId = typeof InstanceId.Type

// Task 1 (multi-edition lifecycle): 後続タスクの durable Operation / ResourceBinding /
// Artifact の識別子。portal/src/domain/ids.ts と同名の構造的ブランド。
export const OperationId = Schema.String.pipe(Schema.brand("OperationId"))
export type OperationId = typeof OperationId.Type

export const OperationStepId = Schema.String.pipe(Schema.brand("OperationStepId"))
export type OperationStepId = typeof OperationStepId.Type

export const ResourceBindingId = Schema.String.pipe(Schema.brand("ResourceBindingId"))
export type ResourceBindingId = typeof ResourceBindingId.Type

export const ArtifactId = Schema.String.pipe(Schema.brand("ArtifactId"))
export type ArtifactId = typeof ArtifactId.Type

// Task 8: readiness aggregation の wire schema。key/status/summary の 3 タプル。
// summary は非機密文字列(生 email / bearer / cause 等を絶対に含まない)。
export const ReadinessCheckStatus = Schema.Literal("pass", "warn", "fail")
export type ReadinessCheckStatus = typeof ReadinessCheckStatus.Type

export const ReadinessCheck = Schema.Struct({
  key: Schema.String,
  status: ReadinessCheckStatus,
  summary: Schema.String
})
export type ReadinessCheck = typeof ReadinessCheck.Type

export const User = Schema.Struct({
  id: UserId,
  githubId: Schema.Int,
  githubLogin: Schema.String,
  displayName: Schema.String,
  isAdmin: Schema.Boolean,
  // Phase 3: Cloudflare Access ログイン用メール(admin が招待時に入力する。
  // GitHub OAuth では取得しない)。CurrentUser タグ経由で domain の User を
  // そのまま橋渡しするため、domain/user.ts と同一の表現(OptionFromNullOr =
  // Type は Option<string>、wire は null 許容文字列)にして構造的に一致させる。
  email: Schema.OptionFromNullOr(Schema.String)
})
export type User = typeof User.Type

export const Team = Schema.Struct({
  id: TeamId,
  contestId: ContestId,
  name: Schema.String,
  teamNumber: Schema.Int.pipe(Schema.between(1, 254)),
  desiredInstanceCount: Schema.Int.pipe(Schema.nonNegative())
})
export type Team = typeof Team.Type

// GET /api/me のレスポンス。チーム未所属は team: null。
export const Me = Schema.Struct({
  user: User,
  team: Schema.NullOr(Team)
})
export type Me = typeof Me.Type

// Task 1 (multi-edition lifecycle): 6状態遷移 (draft -> preparing -> running ->
// finalizing -> finished、draft|preparing -> canceled)。
export const ContestStatus = Schema.Literal(
  "draft",
  "preparing",
  "running",
  "finalizing",
  "finished",
  "canceled"
)
export type ContestStatus = typeof ContestStatus.Type

// Phase 3: チームごとのインスタンス上限(domain/contest.ts の instanceQuota と
// 同形。Team ページの追加ボタン活性判定に使う)。
// Task 1: 開催回スコープ(edition/problemRevision/templateVmid)と schedule/
// closed timestamps(Option -> nullable int)を追加。domain 側は Option、
// wire 側は null で表現する(既存の User.email と同じ規約)。
export const Contest = Schema.Struct({
  id: ContestId,
  edition: Schema.Int.pipe(Schema.positive()),
  name: Schema.String,
  problemKey: Schema.String,
  problemRevision: Schema.String,
  templateVmid: Schema.Int.pipe(Schema.positive()),
  status: ContestStatus,
  instanceQuota: Schema.Int.pipe(Schema.positive()),
  scheduledStartAt: Schema.OptionFromNullOr(Schema.Int),
  scheduledEndAt: Schema.OptionFromNullOr(Schema.Int),
  accessClosesAt: Schema.OptionFromNullOr(Schema.Int),
  cleanupAt: Schema.OptionFromNullOr(Schema.Int),
  accessClosedAt: Schema.OptionFromNullOr(Schema.Int),
  cleanupCompletedAt: Schema.OptionFromNullOr(Schema.Int),
  startedAt: Schema.OptionFromNullOr(Schema.Int),
  finalizingAt: Schema.OptionFromNullOr(Schema.Int),
  finishedAt: Schema.OptionFromNullOr(Schema.Int),
  canceledAt: Schema.OptionFromNullOr(Schema.Int),
  revision: Schema.Int.pipe(Schema.positive())
})
export type Contest = typeof Contest.Type

// Task 5: admin draft wizard 用のリクエスト DTO。domain の Contest は Option
// を持つが、wire は null 許容の Int にする(User.email と同じ規約)。schedule
// の順序検査は portal usecase 側 (InvalidContestSchedule) が担うのでここでは
// 値の presence だけを型で表現する。
export const CreateContestDraftRequest = Schema.Struct({
  edition: Schema.Int.pipe(Schema.positive()),
  name: Schema.String,
  problemKey: Schema.String,
  problemRevision: Schema.String,
  templateVmid: Schema.Int.pipe(Schema.positive()),
  instanceQuota: Schema.Int.pipe(Schema.positive()),
  scheduledStartAt: Schema.NullOr(Schema.Int),
  scheduledEndAt: Schema.NullOr(Schema.Int),
  accessClosesAt: Schema.NullOr(Schema.Int),
  cleanupAt: Schema.NullOr(Schema.Int)
})
export type CreateContestDraftRequest = typeof CreateContestDraftRequest.Type

// PATCH /api/admin/contests/:contestId(部分更新)。patch 内は「省略=変更なし」、
// null = 明示的に unset(schedule フィールドのみ)。expectedRevision は楽観
// ロック用。
export const ContestDraftPatch = Schema.Struct({
  name: Schema.optional(Schema.String),
  problemKey: Schema.optional(Schema.String),
  problemRevision: Schema.optional(Schema.String),
  templateVmid: Schema.optional(Schema.Int.pipe(Schema.positive())),
  instanceQuota: Schema.optional(Schema.Int.pipe(Schema.positive())),
  scheduledStartAt: Schema.optional(Schema.NullOr(Schema.Int)),
  scheduledEndAt: Schema.optional(Schema.NullOr(Schema.Int)),
  accessClosesAt: Schema.optional(Schema.NullOr(Schema.Int)),
  cleanupAt: Schema.optional(Schema.NullOr(Schema.Int))
})
export type ContestDraftPatch = typeof ContestDraftPatch.Type

export const UpdateContestDraftRequest = Schema.Struct({
  expectedRevision: Schema.Int.pipe(Schema.positive()),
  patch: ContestDraftPatch
})
export type UpdateContestDraftRequest = typeof UpdateContestDraftRequest.Type

// POST /api/admin/contests/:contestId/{prepare,cancel}: 楽観ロック用の
// expectedRevision のみを受ける空 body 系のラッパ。
export const ContestTransitionRequest = Schema.Struct({
  expectedRevision: Schema.Int.pipe(Schema.positive())
})
export type ContestTransitionRequest = typeof ContestTransitionRequest.Type

// POST /api/admin/contests/:contestId/roster/copy: source contest から現在の
// draft contest へロスターを複製する。
export const CopyContestRosterRequest = Schema.Struct({
  sourceContestId: ContestId
})
export type CopyContestRosterRequest = typeof CopyContestRosterRequest.Type

// POST /api/admin/contests/:contestId/rehearsal: 指定 Instance に対して
// purpose='rehearsal' の BenchJob を投入する(admin + preparing のみ)。
export const EnqueueRehearsalRequest = Schema.Struct({
  instanceId: InstanceId
})
export type EnqueueRehearsalRequest = typeof EnqueueRehearsalRequest.Type

// GET /api/teams のメンバー表現。チームメイトの githubLogin を返す(auth の
// User 全体を返すと isAdmin 等の不要な情報まで漏れるため最小限にする)。
export const TeamMember = Schema.Struct({
  id: UserId,
  githubLogin: Schema.String,
  displayName: Schema.String
})
export type TeamMember = typeof TeamMember.Type

export const TeamWithMembers = Schema.Struct({
  ...Team.fields,
  members: Schema.Array(TeamMember)
})
export type TeamWithMembers = typeof TeamWithMembers.Type

// Phase 3: instance.ts(domain)の状態機械と同じ値集合(境界のコピー、正は
// portal/src/domain/instance.ts)。
export const InstanceStatus = Schema.Literal("creating", "running", "deleting", "deleted", "failed")
export type InstanceStatus = typeof InstanceStatus.Type

export const ProvisionStep = Schema.Literal("clone_done", "configured", "started", "route_done", "access_done")
export type ProvisionStep = typeof ProvisionStep.Type

// domain の Instance(errorMessage が Option)は境界を跨がないため、ハンドラが
// Option.getOrNull で変換してこの Struct(null 許容)に合わせる(BenchJob と
// 同じ方針)。
export const Instance = Schema.Struct({
  id: InstanceId,
  contestId: ContestId,
  teamId: TeamId,
  index: Schema.Int.pipe(Schema.positive()),
  vmid: Schema.Int,
  privateIp: Schema.String,
  status: InstanceStatus,
  progress: Schema.Array(ProvisionStep),
  errorMessage: Schema.NullOr(Schema.String),
  createdAt: Schema.Int,
  updatedAt: Schema.Int
})
export type Instance = typeof Instance.Type

// POST /api/teams
export const CreateTeamRequest = Schema.Struct({
  name: Schema.String,
  teamNumber: Schema.Int.pipe(Schema.between(1, 254))
})
export type CreateTeamRequest = typeof CreateTeamRequest.Type

// PUT /api/teams/:id/members
export const SetTeamMembersRequest = Schema.Struct({
  githubLogins: Schema.Array(Schema.String)
})
export type SetTeamMembersRequest = typeof SetTeamMembersRequest.Type

// POST /api/instances: admin 専用の台帳取り込み経路(スペック §HTTP API
// 差分)。vmid は省略可能 — 省略時は従来どおり vmidFor(teamNumber, index) で
// 計算するが、Terraform 製 VM のように式に従わない実 VM を取り込む場合は
// vmid を明示指定して実際の Proxmox vmid と台帳を一致させる。
export const CreateInstanceRequest = Schema.Struct({
  teamId: TeamId,
  index: Schema.Int.pipe(Schema.positive()),
  privateIp: Schema.String,
  vmid: Schema.optional(Schema.Int)
})
export type CreateInstanceRequest = typeof CreateInstanceRequest.Type

// POST /api/teams/:id/instances(追加ボタン、セルフサービス。スペック §HTTP
// API 差分)。privateIp/vmid/index はすべてサーバー側で算出する(Task 6 レビュー
// #1: クライアント指定の index を無検証で使うと vmid/IP 不変条件が壊れて衝突・
// 不正 IP に到達しうるため、index もサーバー採番=公平性のためユーザー入力を
// 受けない)。ペイロードは空。
export const CreateTeamInstanceRequest = Schema.Struct({})
export type CreateTeamInstanceRequest = typeof CreateTeamInstanceRequest.Type

// POST /api/admin/teams/:id/invites(admin。スペック §招待フロー)。email は
// Access ログイン用(admin 入力。GitHub からは取得しない)。
export const InviteRequest = Schema.Struct({
  githubLogin: Schema.String,
  email: Schema.String
})
export type InviteRequest = typeof InviteRequest.Type

// GET /api/admin/teams/:id/invites: 招待中(未消費)の team_invites 行。
export const TeamInvite = Schema.Struct({
  contestId: ContestId,
  githubLogin: Schema.String,
  teamId: TeamId,
  email: Schema.String,
  invitedAt: Schema.Int
})
export type TeamInvite = typeof TeamInvite.Type

// 招待 API の結果(スペック §招待フロー: 3 点の成否 + email 未登録 warning)。
// portal は即所属("assigned")か事前招待("pending")か。access は Access
// ポリシー更新の成否、sshKeys は各 running インスタンスへの鍵注入の成否。
// warnings は email 未登録のため Access に載せられなかったメンバーの
// githubLogin 一覧(黙って外さないための可視化)。
export const InviteSshKeyResult = Schema.Struct({
  instance: InstanceId,
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String)
})
export type InviteSshKeyResult = typeof InviteSshKeyResult.Type

export const InviteAccessResult = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String)
})
export type InviteAccessResult = typeof InviteAccessResult.Type

export const InviteResult = Schema.Struct({
  portal: Schema.Literal("assigned", "pending"),
  access: InviteAccessResult,
  sshKeys: Schema.Array(InviteSshKeyResult),
  warnings: Schema.Array(Schema.String)
})
export type InviteResult = typeof InviteResult.Type

export const BenchJobId = Schema.String.pipe(Schema.brand("BenchJobId"))
export type BenchJobId = typeof BenchJobId.Type

export const BenchJobStatus = Schema.Literal("queued", "running", "finished", "canceled", "failed")
export type BenchJobStatus = typeof BenchJobStatus.Type

export const BenchJobPurpose = Schema.Literal("rehearsal", "competition")
export type BenchJobPurpose = typeof BenchJobPurpose.Type

// domain の BenchJob(Option フィールド)は境界を跨がないため、ハンドラが
// Option.getOrNull で変換してこの Struct(null 許容)に合わせる(teams.ts の
// toTeamMember と同じ方針)。
export const BenchJob = Schema.Struct({
  id: BenchJobId,
  contestId: ContestId,
  teamId: TeamId,
  targetIp: Schema.String,
  targetPort: Schema.Int.pipe(Schema.between(1, 65535)),
  status: BenchJobStatus,
  purpose: BenchJobPurpose,
  score: Schema.NullOr(Schema.Int),
  passed: Schema.NullOr(Schema.Boolean),
  errorMessage: Schema.NullOr(Schema.String),
  enqueuedAt: Schema.Int,
  startedAt: Schema.NullOr(Schema.Int),
  finishedAt: Schema.NullOr(Schema.Int)
})
export type BenchJob = typeof BenchJob.Type

// GET /api/bench-jobs/:id: 一覧(BenchJob)にログを足したもの。詳細のみ返す
// 理由はスペック §2(一覧クエリにログを引きずらないため bench_job_logs を
// 別テーブルにしている)。
export const BenchJobDetail = Schema.Struct({
  ...BenchJob.fields,
  log: Schema.String
})
export type BenchJobDetail = typeof BenchJobDetail.Type

// POST /api/bench-jobs: instanceId 指定時は InstanceRepo で privateIp を解決し
// targetPort=80 固定にする。どちらの形も受ける(スペック §2 bench)。
export const EnqueueBenchRequest = Schema.Union(
  Schema.Struct({ instanceId: InstanceId }),
  Schema.Struct({ targetIp: Schema.String, targetPort: Schema.Int.pipe(Schema.between(1, 65535)) })
)
export type EnqueueBenchRequest = typeof EnqueueBenchRequest.Type

// domain/errors.ts の JobAction(portal 内部)と同形の契約側コピー。domain 型を
// shared から import しない方針(shared はランナーとも共有するため portal の
// domain には依存しない)。
export const JobAction = Schema.Literal("start", "recordProgress", "finish", "fail", "cancel")
export type JobAction = typeof JobAction.Type

// --- runner 契約(ランナーが HttpApiClient で使う。これが正) ---

export const RunnerJob = Schema.Struct({
  id: BenchJobId,
  teamId: TeamId,
  targetIp: Schema.String,
  targetPort: Schema.Int.pipe(Schema.between(1, 65535)),
  problemKey: Schema.String
})
export type RunnerJob = typeof RunnerJob.Type

// POST /api/runner/jobs/poll: Task 10 で追加した heartbeat 兼 poll。
// runnerId は複数 runner を将来サポートするための識別子(現行は "benchvm" 固定
// 相当)、revision は動作している runner バイナリの識別子(git commit hash / dev)、
// benchReady はランナー側で BENCH_DIR / adapter 実行可能性を確認した結果、
// healthSummary は非機密の短文サマリ(bearer / 生 cause / email を含まない、
// 長さは DB 側の CHECK と同じ 256 文字以内)。
export const RunnerPollRequest = Schema.Struct({
  runnerId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
  revision: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
  benchReady: Schema.Boolean,
  healthSummary: Schema.String.pipe(Schema.maxLength(256))
})
export type RunnerPollRequest = typeof RunnerPollRequest.Type

// POST /api/runner/jobs/poll
export const PollJobResponse = Schema.Struct({ job: Schema.NullOr(RunnerJob) })
export type PollJobResponse = typeof PollJobResponse.Type

// POST /api/runner/jobs/:id/progress
export const RunnerProgressRequest = Schema.Struct({
  logChunk: Schema.String,
  partialScore: Schema.NullOr(Schema.Int)
})
export type RunnerProgressRequest = typeof RunnerProgressRequest.Type

// POST /api/runner/jobs/:id/finish: passed/score は成功時、実行自体の失敗
// (バイナリ異常終了等)は errorMessage 付き・passed=false, score=0 で送る。
export const RunnerFinishRequest = Schema.Struct({
  passed: Schema.Boolean,
  score: Schema.Int,
  errorMessage: Schema.NullOr(Schema.String),
  logTail: Schema.String
})
export type RunnerFinishRequest = typeof RunnerFinishRequest.Type

// GET /api/scoreboard: チームごとの最新/ベストスコア(BenchJobRepo.scoreboard、
// Task 4 で集計済み)。finished 以外のジョブは集計対象外、0 件チームも
// bestScore/latestScore/latestAt=null で必ず返る。
export const ScoreboardEntry = Schema.Struct({
  teamId: TeamId,
  teamName: Schema.String,
  bestScore: Schema.NullOr(Schema.Int),
  latestScore: Schema.NullOr(Schema.Int),
  latestAt: Schema.NullOr(Schema.Int)
})
export type ScoreboardEntry = typeof ScoreboardEntry.Type

// Task 7: reconciliation plan の wire 表現。domain/reconciliation.ts と同型で、
// 生 email / bearer / provider ID は含まない(hostname / classification /
// action / 観測件数 / sanitized reason のみ)。
export const ReconciliationClass = Schema.Literal(
  "in_sync",
  "missing",
  "drifted",
  "managed_orphan",
  "unmanaged_orphan",
  "ambiguous"
)
export type ReconciliationClass = typeof ReconciliationClass.Type

export const ReconciliationAction = Schema.Literal("noop", "cleanup", "adopt_cleanup", "blocked")
export type ReconciliationAction = typeof ReconciliationAction.Type

export const ReconciliationEntry = Schema.Struct({
  hostname: Schema.String,
  classification: ReconciliationClass,
  action: ReconciliationAction,
  reason: Schema.String,
  proxmoxVmObserved: Schema.Boolean,
  cloudflareRouteCount: Schema.Int,
  cloudflareIngressCount: Schema.Int,
  cloudflareAppCount: Schema.Int,
  bindingIds: Schema.Array(ResourceBindingId),
  instanceId: Schema.NullOr(InstanceId)
})
export type ReconciliationEntry = typeof ReconciliationEntry.Type

export const ReconciliationPlan = Schema.Struct({
  contestId: ContestId,
  contestRevision: Schema.Int.pipe(Schema.positive()),
  planDigest: Schema.String,
  generatedAt: Schema.Int,
  entries: Schema.Array(ReconciliationEntry),
  adoptHostnames: Schema.Array(Schema.String)
})
export type ReconciliationPlan = typeof ReconciliationPlan.Type

export const ReconciliationPlanRequest = Schema.Struct({
  adoptHostnames: Schema.Array(Schema.String)
})
export type ReconciliationPlanRequest = typeof ReconciliationPlanRequest.Type

// review round 8 #2: 以前は planDigest と別に contestRevision を受けていたが、
// planDigest は contestRevision を digest 材料に含むため、planDigest 一致 ⇒
// contestRevision 一致で dead check になっていた(round 3 で dead 分岐を
// 削除済み)。UI に「stale revision を弾く」誤解を招く dead surface だったので
// wire からも外す。楽観ロックは planDigest のみで機能する。
export const ReconciliationApplyRequest = Schema.Struct({
  planDigest: Schema.String,
  adoptHostnames: Schema.Array(Schema.String)
})
export type ReconciliationApplyRequest = typeof ReconciliationApplyRequest.Type

// Task 7: Operation の wire 表現。durable operation の enqueue 応答 / 取得で使う。
// sanitizedError は非機密 code + summary + details のみ(domain の
// SanitizedOperationError と同型)。
export const OperationKind = Schema.Literal(
  "reconcile",
  "enter_contest_mode",
  "prepare",
  "start",
  "finish",
  "revoke_access",
  "cleanup",
  "return_normal_mode",
  "backup"
)
export type OperationKind = typeof OperationKind.Type

export const OperationStatus = Schema.Literal(
  "queued",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "canceled"
)
export type OperationStatus = typeof OperationStatus.Type

export const SanitizedOperationError = Schema.Struct({
  code: Schema.String,
  summary: Schema.String,
  details: Schema.Record({ key: Schema.String, value: Schema.String })
})
export type SanitizedOperationError = typeof SanitizedOperationError.Type

export const OperationActor = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("admin"), userId: UserId }),
  Schema.Struct({ kind: Schema.Literal("scheduler") })
)
export type OperationActor = typeof OperationActor.Type

export const Operation = Schema.Struct({
  id: OperationId,
  contestId: ContestId,
  kind: OperationKind,
  status: OperationStatus,
  actor: OperationActor,
  planDigest: Schema.String,
  contestRevision: Schema.Int.pipe(Schema.positive()),
  sanitizedError: Schema.NullOr(SanitizedOperationError),
  createdAt: Schema.Int,
  startedAt: Schema.NullOr(Schema.Int),
  finishedAt: Schema.NullOr(Schema.Int)
})
export type Operation = typeof Operation.Type
