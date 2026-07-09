// web/dist(portal/web の Vite ビルド成果物)を配信する HttpMiddleware。
// - /api, /auth, /docs は HttpApi のルータ(httpApp)にそのまま委譲する
// - /assets/* はファイルとして配信する
// - それ以外の非 API パスは index.html を返す(SPA フォールバック。
//   react-router-dom のクライアントサイドルーティングに任せる)
// - パストラバーサル対策: リクエストパスを dist ディレクトリ配下に resolve
//   した後、その結果が dist 配下であることを確認する(スペック §7 / ブリーフ)。
//   加えて、dist 配下に外部を指すシンボリックリンクが置かれるケースに備え、
//   /assets/* の配信前に fs.promises.realpath で実体パスを解決し、その実体が
//   dist(root)の実体配下であることも確認する(文字列比較だけでは symlink 経由の
//   トラバーサルを防げないため)。root の realpath は起動時に 1 回だけ解決して
//   キャッシュする(realpath が失敗する場合は 404 として扱う)
// - web/dist が無い場合(未ビルド)は 404 + 警告ログを返す。開発時は Vite dev
//   server + proxy(vite.config.ts の server.proxy)を使うことを想定している。
import { readFile, realpath } from "node:fs/promises"
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

// /api, /auth, /docs への委譲判定。セグメント境界を見ずに startsWith だけで
// 判定すると "/apiFOOBAR" のような無関係なパスまで誤って委譲してしまうため、
// 「完全一致 または 直後がスラッシュ」の場合のみ委譲する。
const DELEGATED_PREFIXES = ["/api", "/auth", "/docs"] as const

const isDelegatedPath = (pathname: string): boolean =>
  DELEGATED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))

// path.resolve の文字列比較だけでは、dist 配下に外部を指すシンボリックリンクが
// 置かれていた場合のトラバーサルを防げない(readFile はシンボリックリンクを
// 追跡してしまう)。realpath で実体パスを解決できない(存在しない/壊れた
// symlink 等)場合は null を返し、呼び出し側で 404 として扱う。
const safeRealpath = (path: string): Promise<string | null> => realpath(path).catch(() => null)

// /assets/* 配信専用: 文字列上の dist 配下チェックに加え、実体パス
// (symlink 解決後)が dist(root)の実体配下であることを確認してから配信する。
const serveAssetSafely = (
  requestedPath: string,
  getRootRealPath: () => Promise<string | null>
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  Effect.gen(function* () {
    const rootReal = yield* Effect.promise(getRootRealPath)
    if (rootReal === null) {
      return HttpServerResponse.empty({ status: 404 })
    }

    const targetReal = yield* Effect.promise(() => safeRealpath(requestedPath))
    if (targetReal === null || !isWithinRoot(rootReal, targetReal)) {
      return HttpServerResponse.empty({ status: 404 })
    }

    return yield* serveFile(requestedPath)
  })

/**
 * web/dist を配信する HttpMiddleware を作る。main.ts で
 * `HttpApiBuilder.serve((httpApp) => makeStaticMiddleware(distDir)(httpApp))`
 * のように渡す。
 */
export const makeStaticMiddleware = (distDir: string) => {
  const root = resolve(distDir)

  // root の realpath は起動時(初回リクエスト時)に 1 回だけ解決してキャッシュする。
  let rootRealPathPromise: Promise<string | null> | undefined
  const getRootRealPath = (): Promise<string | null> => {
    if (rootRealPathPromise === undefined) {
      rootRealPathPromise = safeRealpath(root)
    }
    return rootRealPathPromise
  }

  return <E, R>(
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

      if (isDelegatedPath(pathname)) {
        return yield* httpApp
      }

      if (pathname.startsWith("/assets/")) {
        const requestedPath = resolve(root, `.${pathname}`)
        if (!isWithinRoot(root, requestedPath)) {
          return HttpServerResponse.empty({ status: 404 })
        }
        return yield* serveAssetSafely(requestedPath, getRootRealPath)
      }

      // SPA フォールバック: ルーティングは react-router-dom に任せ、常に
      // index.html を返す。
      return yield* serveFile(resolve(root, "index.html"))
    })
}
