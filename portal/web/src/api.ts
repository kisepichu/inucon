// fetch ラッパ。型は shared の Schema(shared/schemas)から import する
// (同一 monorepo なので OpenAPI 生成は使わない。スペック §7)。
// ランタイムの decode 検証はしない(サーバー契約を信頼する。UI は最小限)。
import type {
  BenchJob,
  BenchJobDetail,
  Contest,
  CreateInstanceRequest,
  CreateTeamRequest,
  EnqueueBenchRequest,
  Instance,
  Me,
  ScoreboardEntry,
  SetTeamMembersRequest,
  Team,
  TeamWithMembers
} from "shared/schemas"

// サーバーのエラーは `{ "_tag": "..." }` JSON + status で返る(スペック調査メモ §6)。
export class ApiError extends Error {
  constructor(
    readonly tag: string,
    readonly status: number
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
    try {
      const data: unknown = await res.json()
      if (typeof data === "object" && data !== null && "_tag" in data && typeof data._tag === "string") {
        tag = data._tag
      }
    } catch {
      // ボディが JSON でない場合はタグ不明のまま扱う。
    }
    throw new ApiError(tag, res.status)
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

  getScoreboard: () => request<Array<ScoreboardEntry>>("/api/scoreboard"),

  listTeams: () => request<Array<TeamWithMembers>>("/api/teams"),
  createTeam: (body: CreateTeamRequest) => request<Team>("/api/teams", { method: "POST", body }),
  setTeamMembers: (teamId: string, body: SetTeamMembersRequest) =>
    request<TeamWithMembers>(`/api/teams/${teamId}/members`, { method: "PUT", body }),

  listTeamInstances: (teamId: string) => request<Array<Instance>>(`/api/teams/${teamId}/instances`),
  createInstance: (body: CreateInstanceRequest) => request<Instance>("/api/instances", { method: "POST", body }),
  deleteInstance: (id: string) => request<void>(`/api/instances/${id}`, { method: "DELETE" }),

  startContest: () => request<Contest>("/api/admin/contest/start", { method: "POST" }),
  finishContest: () => request<Contest>("/api/admin/contest/finish", { method: "POST" }),

  enqueueBench: (body: EnqueueBenchRequest) => request<BenchJob>("/api/bench-jobs", { method: "POST", body }),
  listBenchJobs: (teamId: string) => request<Array<BenchJob>>(`/api/bench-jobs?teamId=${encodeURIComponent(teamId)}`),
  getBenchJob: (id: string) => request<BenchJobDetail>(`/api/bench-jobs/${id}`),
  cancelBenchJob: (id: string) => request<BenchJob>(`/api/bench-jobs/${id}/cancel`, { method: "POST" })
}
