import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity
} from "@effect/platform"
import { Context, Schema } from "effect"
import { Me, User } from "./schemas.js"

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

export const api = HttpApi.make("inucon").add(healthGroup).add(authGroup)
