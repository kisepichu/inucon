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
  name: Schema.String,
  teamNumber: Schema.Int.pipe(Schema.between(1, 254))
})
export type Team = typeof Team.Type

// GET /api/me のレスポンス。チーム未所属は team: null。
export const Me = Schema.Struct({
  user: User,
  team: Schema.NullOr(Team)
})
export type Me = typeof Me.Type

export const ContestStatus = Schema.Literal("preparing", "running", "finished")
export type ContestStatus = typeof ContestStatus.Type

export const Contest = Schema.Struct({
  id: ContestId,
  name: Schema.String,
  problemKey: Schema.String,
  status: ContestStatus
})
export type Contest = typeof Contest.Type

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

export const BenchJobId = Schema.String.pipe(Schema.brand("BenchJobId"))
export type BenchJobId = typeof BenchJobId.Type

export const BenchJobStatus = Schema.Literal("queued", "running", "finished", "canceled", "failed")
export type BenchJobStatus = typeof BenchJobStatus.Type

// domain の BenchJob(Option フィールド)は境界を跨がないため、ハンドラが
// Option.getOrNull で変換してこの Struct(null 許容)に合わせる(teams.ts の
// toTeamMember と同じ方針)。
export const BenchJob = Schema.Struct({
  id: BenchJobId,
  teamId: TeamId,
  targetIp: Schema.String,
  targetPort: Schema.Int.pipe(Schema.between(1, 65535)),
  status: BenchJobStatus,
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
