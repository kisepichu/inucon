# スパイク記録: HttpApi でのリダイレクト + Set-Cookie(Task 5)

- HttpApi のみで実現可能: エンドポイントを `.addSuccess(HttpApiSchema.Empty(302))` で宣言し、実装側を `handlers.handleRaw` にして `HttpServerResponse.redirect(url, { status: 302 }).pipe(HttpServerResponse.setCookie(...))` を返せば 302 + Set-Cookie(HttpOnly/Secure/SameSite/Max-Age 込み)がそのまま返る(@effect/platform 0.96.2 で実測)。
- 素の HttpRouter を `/auth/*` に挟む案は不要になったため不採用(main.ts の合成は HttpApiBuilder.serve のままで変更なし)。
- 注意: `handleRaw` でも path/urlParams の Schema デコードと `.addError` のエラー encode は通常どおり効く(payload のデコードだけがスキップされる)。
