// fetch ラッパ。型は shared の Schema(shared/schemas)から import する
// (同一 monorepo なので OpenAPI 生成は使わない。スペック §7)。
// ランタイムの decode 検証はしない(サーバー契約を信頼する。UI は最小限)。
import type {
  Artifact,
  ArtifactId,
  BenchJob,
  BenchJobDetail,
  CleanupApplyRequest,
  Contest,
  ContestId,
  ContestTransitionRequest,
  CopyContestRosterRequest,
  CreateContestDraftRequest,
  CreateInstanceRequest,
  CreateTeamInstanceRequest,
  CreateTeamRequest,
  EnqueueBenchRequest,
  EnqueueRehearsalRequest,
  Instance,
  InviteRequest,
  InviteResult,
  Me,
  Operation,
  OperationId,
  OperationWithSteps,
  ReadinessCheck,
  ReconciliationApplyRequest,
  ReconciliationPlan,
  ReconciliationPlanRequest,
  ScoreboardEntry,
  SetTeamMembersRequest,
  Team,
  TeamInvite,
  TeamWithMembers,
  UpdateContestDraftRequest,
  VerifyArtifactRequest
} from "shared/schemas"

// サーバーのエラーは `{ "_tag": "..." }` JSON + status で返る(スペック調査メモ §6)。
// Task 13 追加: 409 stale / 422 ambiguous / 409 revision conflict 系は tag のみで
// 分岐すれば十分 (詳細フィールド {expected, actual, hostnames, failingChecks} は
// UI が透過的に表示するために payload に含めるが、この class は tag と status
// だけを持ち、payload は catch サイトで json 再デシリアライズせず必要なら
// 別途取得する)。
export class ApiError extends Error {
  constructor(
    readonly tag: string,
    readonly status: number,
    readonly details?: Readonly<Record<string, unknown>>
  ) {
    super(`API error: ${tag} (${status})`)
  }
}

interface RequestOptions {
  readonly method?: string
  readonly body?: unknown
}

const request = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
  const hasBody = options.body !== undefined
  const res = await fetch(path, {
    method: options.method ?? "GET",
    // セッション cookie は同一オリジンにのみ送る。
    credentials: "same-origin",
    headers: hasBody ? { "Content-Type": "application/json" } : undefined,
    body: hasBody ? JSON.stringify(options.body) : undefined
  })

  if (!res.ok) {
    let tag = "UnknownError"
    let details: Readonly<Record<string, unknown>> | undefined
    try {
      const data: unknown = await res.json()
      if (typeof data === "object" && data !== null && "_tag" in data && typeof data._tag === "string") {
        tag = data._tag
        details = data as Readonly<Record<string, unknown>>
      }
    } catch {
      // ボディが JSON でない場合はタグ不明のまま扱う。
    }
    throw new ApiError(tag, res.status, details)
  }

  if (res.status === 204) {
    return undefined as T
  }

  return (await res.json()) as T
}

export const loginUrl = "/auth/github"

export const api = {
  getMe: () => request<Me>("/api/me"),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),

  getContest: () => request<Contest>("/api/contest"),
  // Task 4: 公開 archive API。canceled は list/detail の両方から除外される。
  listContests: () => request<Array<Contest>>("/api/contests"),
  getContestById: (contestId: string) => request<Contest>(`/api/contests/${contestId}`),
  getContestScoreboard: (contestId: string) =>
    request<Array<ScoreboardEntry>>(`/api/contests/${contestId}/scoreboard`),

  getScoreboard: () => request<Array<ScoreboardEntry>>("/api/scoreboard"),

  listTeams: () => request<Array<TeamWithMembers>>("/api/teams"),
  createTeam: (body: CreateTeamRequest) => request<Team>("/api/teams", { method: "POST", body }),
  setTeamMembers: (teamId: string, body: SetTeamMembersRequest) =>
    request<TeamWithMembers>(`/api/teams/${teamId}/members`, { method: "PUT", body }),

  listTeamInstances: (teamId: string) => request<Array<Instance>>(`/api/teams/${teamId}/instances`),
  // admin 専用の台帳取り込み経路(Terraform 製 VM の登録用。Phase 2 から引き継ぎ)。
  createInstance: (body: CreateInstanceRequest) => request<Instance>("/api/instances", { method: "POST", body }),
  deleteInstance: (id: string) => request<void>(`/api/instances/${id}`, { method: "DELETE" }),

  // セルフサービス(追加/削除ボタン、Phase 3)。チームメンバー or admin。
  // index/privateIp/vmid はサーバー側で採番するためペイロードは空(Task 6 レビュー #1)。
  createTeamInstance: (teamId: string) =>
    request<Instance>(`/api/teams/${teamId}/instances`, { method: "POST", body: {} satisfies CreateTeamInstanceRequest }),
  deleteTeamInstance: (teamId: string, instanceId: string) =>
    request<void>(`/api/teams/${teamId}/instances/${instanceId}`, { method: "DELETE" }),

  startContest: () => request<Contest>("/api/admin/contest/start", { method: "POST" }),
  finishContest: () => request<Contest>("/api/admin/contest/finish", { method: "POST" }),

  // 招待自動化(admin のみ、Phase 3)。
  inviteMember: (teamId: string, body: InviteRequest) =>
    request<InviteResult>(`/api/admin/teams/${teamId}/invites`, { method: "POST", body }),
  listInvites: (teamId: string) => request<Array<TeamInvite>>(`/api/admin/teams/${teamId}/invites`),

  // Task 5: draft wizard 用の contest 管理 API。
  listAdminContests: (includeCanceled = false) =>
    request<Array<Contest>>(`/api/admin/contests${includeCanceled ? "?includeCanceled=true" : ""}`),
  getAdminContest: (contestId: string) => request<Contest>(`/api/admin/contests/${contestId}`),
  createContestDraft: (body: CreateContestDraftRequest) =>
    request<Contest>("/api/admin/contests", { method: "POST", body }),
  updateContestDraft: (contestId: string, body: UpdateContestDraftRequest) =>
    request<Contest>(`/api/admin/contests/${contestId}`, { method: "PATCH", body }),
  beginContestPreparation: (contestId: string, body: ContestTransitionRequest) =>
    request<Contest>(`/api/admin/contests/${contestId}/prepare`, { method: "POST", body }),
  cancelAdminContest: (contestId: string, body: ContestTransitionRequest) =>
    request<Contest>(`/api/admin/contests/${contestId}/cancel`, { method: "POST", body }),
  copyContestRoster: (contestId: string, body: CopyContestRosterRequest) =>
    request<Array<Team>>(`/api/admin/contests/${contestId}/roster/copy`, { method: "POST", body }),

  enqueueBench: (body: EnqueueBenchRequest) => request<BenchJob>("/api/bench-jobs", { method: "POST", body }),
  listBenchJobs: (teamId: string) => request<Array<BenchJob>>(`/api/bench-jobs?teamId=${encodeURIComponent(teamId)}`),
  getBenchJob: (id: string) => request<BenchJobDetail>(`/api/bench-jobs/${id}`),
  cancelBenchJob: (id: string) => request<BenchJob>(`/api/bench-jobs/${id}/cancel`, { method: "POST" }),

  // Task 7-12: reconciliation / readiness / start / cleanup / return-normal-mode
  // (durable Operation を返す admin 経路)。UI は返された Operation を polling する。
  getContestReadiness: (contestId: ContestId) =>
    request<Array<ReadinessCheck>>(`/api/admin/contests/${contestId}/readiness`),
  planReconciliation: (contestId: ContestId, body: ReconciliationPlanRequest) =>
    request<ReconciliationPlan>(`/api/admin/contests/${contestId}/reconciliation/plan`, {
      method: "POST",
      body
    }),
  applyReconciliation: (contestId: ContestId, body: ReconciliationApplyRequest) =>
    request<Operation>(`/api/admin/contests/${contestId}/reconciliation/apply`, {
      method: "POST",
      body
    }),
  enqueueRehearsal: (contestId: ContestId, body: EnqueueRehearsalRequest) =>
    request<BenchJob>(`/api/admin/contests/${contestId}/rehearsal`, { method: "POST", body }),
  requestContestStart: (contestId: ContestId, body: ContestTransitionRequest) =>
    request<Operation>(`/api/admin/contests/${contestId}/start`, { method: "POST", body }),
  requestContestFinalize: (contestId: ContestId, body: ContestTransitionRequest) =>
    request<Operation>(`/api/admin/contests/${contestId}/finalize`, { method: "POST", body }),
  requestContestCleanup: (contestId: ContestId, body: CleanupApplyRequest) =>
    request<Operation>(`/api/admin/contests/${contestId}/cleanup`, { method: "POST", body }),
  requestReturnNormalMode: (contestId: ContestId) =>
    request<Operation>(`/api/admin/contests/${contestId}/return-normal-mode`, { method: "POST" }),
  requestContestArchive: (contestId: ContestId) =>
    request<Operation>(`/api/admin/contests/${contestId}/archive`, { method: "POST" }),

  // Task 11: artifact 一覧 / 検証。生 storagePath は返らない (id のみ)。
  listContestArtifacts: (contestId: ContestId) =>
    request<Array<Artifact>>(`/api/contests/${contestId}/artifacts`),
  verifyArtifactChecksum: (artifactId: ArtifactId, body: VerifyArtifactRequest) =>
    request<Artifact>(`/api/admin/artifacts/${artifactId}/verify`, { method: "POST", body }),

  // Task 13: 単一 Operation 取得 (OperationDetail polling) と contest scoped 一覧。
  // getAdminOperation は steps を含む OperationWithSteps を返す。
  getAdminOperation: (operationId: OperationId) =>
    request<OperationWithSteps>(`/api/admin/operations/${operationId}`),
  listContestOperations: (contestId: ContestId, limit?: number) =>
    request<Array<Operation>>(
      `/api/admin/contests/${contestId}/operations${limit === undefined ? "" : `?limit=${limit}`}`
    )
}
