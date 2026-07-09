// web/dist(portal/web の Vite ビルド成果物)を配信する HttpMiddleware。
// - /api, /auth, /docs は HttpApi のルータ(httpApp)にそのまま委譲する
// - /assets/* はファイルとして配信する
// - それ以外の非 API パスは index.html を返す(SPA フォールバック。
//   react-router-dom のクライアントサイドルーティングに任せる)
// - パストラバーサル対策: リクエストパスを dist ディレクトリ配下に resolve
//   した後、その結果が dist 配下であることを確認する(スペック §7 / ブリーフ)
// - web/dist が無い場合(未ビルド)は 404 + 警告ログを返す。開発時は Vite dev
//   server + proxy(vite.config.ts の server.proxy)を使うことを想定している。
import { readFile } from "node:fs/promises"
import { extname, resolve, sep } from "node:path"
import { HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect } from "effect"

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8"
}

const contentTypeFor = (path: string): string => CONTENT_TYPES[extname(path)] ?? "application/octet-stream"

// dist 配下のファイルを読んでレスポンスにする。存在しない/読めない場合は
// 警告ログを出して 404 を返す(例外で落とさない)。
const serveFile = (absPath: string): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  Effect.tryPromise({
    try: () => readFile(absPath),
    catch: (cause) => cause
  }).pipe(
    Effect.map((buf) => HttpServerResponse.uint8Array(buf, { contentType: contentTypeFor(absPath) })),
    Effect.catchAll((cause) =>
      Effect.logWarning(`static: file not found: ${absPath}`, cause).pipe(
        Effect.as(HttpServerResponse.empty({ status: 404 }))
      )
    )
  )

// resolve 後に dist(root)配下であることを確認する。root 自身も許可する。
const isWithinRoot = (root: string, target: string): boolean => target === root || target.startsWith(root + sep)

/**
 * web/dist を配信する HttpMiddleware を作る。main.ts で
 * `HttpApiBuilder.serve((httpApp) => makeStaticMiddleware(distDir)(httpApp))`
 * のように渡す。
 */
export const makeStaticMiddleware =
  (distDir: string) =>
  <E, R>(
    httpApp: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R | HttpServerRequest.HttpServerRequest> =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest

      let pathname: string
      try {
        pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname)
      } catch {
        return HttpServerResponse.empty({ status: 404 })
      }

      if (pathname.startsWith("/api") || pathname.startsWith("/auth") || pathname.startsWith("/docs")) {
        return yield* httpApp
      }

      const root = resolve(distDir)

      if (pathname.startsWith("/assets/")) {
        const requestedPath = resolve(root, `.${pathname}`)
        if (!isWithinRoot(root, requestedPath)) {
          return HttpServerResponse.empty({ status: 404 })
        }
        return yield* serveFile(requestedPath)
      }

      // SPA フォールバック: ルーティングは react-router-dom に任せ、常に
      // index.html を返す。
      return yield* serveFile(resolve(root, "index.html"))
    })
