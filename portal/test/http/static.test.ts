import { fileURLToPath } from "node:url"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpClient } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { describe, expect } from "vitest"
import { makeStaticMiddleware } from "../../src/infrastructure/http/static.js"

// フィクスチャ: portal/test/fixtures/staticDist(dist 相当) と、その1つ上の
// portal/test/fixtures/secret.txt(dist の外。トラバーサルで読めてはいけない
// カナリアファイル)。
const fixtureDist = fileURLToPath(new URL("../fixtures/staticDist", import.meta.url))
const missingDist = fileURLToPath(new URL("../fixtures/doesNotExist", import.meta.url))

// 静的配信の外側にある HttpApi ルータ役。/api/ping への委譲を確認するための
// 最小 API(auth.test.ts の secureApi と同じ方針: 本物の api を使わず最小限で確認)。
const testApi = HttpApi.make("staticTest").add(
  HttpApiGroup.make("api").add(
    HttpApiEndpoint.get("ping", "/api/ping").addSuccess(Schema.Struct({ ok: Schema.Boolean }))
  )
)

const TestApiLive = HttpApiBuilder.api(testApi).pipe(
  Layer.provide(HttpApiBuilder.group(testApi, "api", (handlers) => handlers.handle("ping", () => Effect.succeed({ ok: true }))))
)

const makeTestLayer = (distDir: string) =>
  HttpApiBuilder.serve((httpApp) => makeStaticMiddleware(distDir)(httpApp)).pipe(
    Layer.provideMerge(TestApiLive),
    Layer.provideMerge(NodeHttpServer.layerTest)
  )

const TestLayer = makeTestLayer(fixtureDist)

describe("static middleware", () => {
  it.effect("/api/* は HttpApi ルータ(httpApp)に委譲される", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/ping")
      expect(res.status).toBe(200)
      const body = yield* res.json
      expect(body).toStrictEqual({ ok: true })
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("/ は index.html を返す(content-type text/html)", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/")
      expect(res.status).toBe(200)
      expect(res.headers["content-type"]).toContain("text/html")
      const body = yield* res.text
      expect(body).toContain("INDEX_MARKER")
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("未知の SPA ルート(/team 等)も index.html にフォールバックする", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/team")
      expect(res.status).toBe(200)
      const body = yield* res.text
      expect(body).toContain("INDEX_MARKER")

      const jobDetail = yield* client.get("/jobs/some-id")
      expect(jobDetail.status).toBe(200)
      const jobBody = yield* jobDetail.text
      expect(jobBody).toContain("INDEX_MARKER")
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("/assets/* はファイルとして配信される(content-type text/javascript)", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/assets/app.js")
      expect(res.status).toBe(200)
      expect(res.headers["content-type"]).toContain("text/javascript")
      const body = yield* res.text
      expect(body).toContain("APP_JS_MARKER")
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("存在しない asset は 404(index.html にフォールバックしない)", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/assets/missing.js")
      expect(res.status).toBe(404)
      const body = yield* res.text
      expect(body).not.toContain("INDEX_MARKER")
    }).pipe(Effect.provide(TestLayer))
  )

  // dist の 1 つ上(test/fixtures/secret.txt)を読もうとするパストラバーサル。
  // 素の "/assets/../../secret.txt" は WHATWG URL パーサ自身が ".." を
  // 正規化して潰してしまう(request.url の pathname は既に "/secret.txt" に
  // なる)ため、境界チェックを実際に踏ませるにはスラッシュ自体もエンコード
  // (%2f)する必要がある(URL パーサはエンコード済みスラッシュをパス区切りと
  // 認識せず、dot-segment の正規化をすり抜けるため)。resolve 後の dist 配下
  // チェックはこの手のエンコード済みトラバーサルへの対策(ブリーフの要求どおり)。
  it.effect("パストラバーサル(/assets/%2e%2e%2f%2e%2e%2fsecret.txt)は 404 になり dist 外のファイルを返さない", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/assets/%2e%2e%2f%2e%2e%2fsecret.txt")
      expect(res.status).toBe(404)
      const body = yield* res.text
      expect(body).not.toContain("SECRET_MARKER")
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("../ 表記(/assets/..%2f..%2fsecret.txt)でのトラバーサルも dist 外に出ず 404", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/assets/..%2f..%2fsecret.txt")
      expect(res.status).toBe(404)
      const body = yield* res.text
      expect(body).not.toContain("SECRET_MARKER")
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("1 段だけの traversal(/assets/..%2fsecret.txt)は dist 内に留まるため 404(ファイル不在)", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/assets/..%2fsecret.txt")
      expect(res.status).toBe(404)
      const body = yield* res.text
      expect(body).not.toContain("SECRET_MARKER")
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("web/dist が存在しない場合", () => {
  const MissingDistLayer = makeTestLayer(missingDist)

  it.effect("index.html が無ければ 404 を返す(例外で落ちない)", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/")
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(MissingDistLayer))
  )

  it.effect("/api/* への委譲は dist の有無に関わらず動く", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/ping")
      expect(res.status).toBe(200)
    }).pipe(Effect.provide(MissingDistLayer))
  )
})
