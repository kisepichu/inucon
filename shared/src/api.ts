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
  Contest,
  ContestStatus,
  CreateInstanceRequest,
  CreateTeamRequest,
  Instance,
  InstanceId,
  Me,
  SetTeamMembersRequest,
  Team,
  TeamId,
  TeamWithMembers,
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

// POST /api/admin/contest/{start,finish}: 不正な状態遷移(domain の
// startContest/finishContest をマップ)。
export class InvalidContestTransition extends Schema.TaggedError<InvalidContestTransition>()(
  "InvalidContestTransition",
  { from: ContestStatus, to: ContestStatus },
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

// GET /api/contest(セッション): 現在のコンテスト。無ければ 404。
export const contestGroup = HttpApiGroup.make("contest").add(
  HttpApiEndpoint.get("getContest", "/api/contest")
    .addSuccess(Contest)
    .addError(NotFound)
    .middleware(Authentication)
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
      .middleware(AdminOnly)
  )
  // 削除は admin のみ。logout と同様に冪等(存在しない id でも 204)。
  .add(
    HttpApiEndpoint.del("deleteInstance")`/api/instances/${HttpApiSchema.param("id", InstanceId)}`
      .addSuccess(HttpApiSchema.NoContent)
      .middleware(AdminOnly)
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

export const api = HttpApi.make("inucon")
  .add(healthGroup)
  .add(authGroup)
  .add(contestGroup)
  .add(teamsGroup)
  .add(instancesGroup)
  .add(adminGroup)
