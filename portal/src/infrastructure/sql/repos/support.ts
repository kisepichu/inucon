import type { SqlError } from "@effect/sql/SqlError"
import { Effect, Option, Schema } from "effect"
import { RepoError } from "../../../application/ports.js"

// SqlError だけを RepoError に変換する。_tag を手動で判定する catchAll に
// することで(catchTag は naked でない generic E だと型検査が deferred
// conditional type に阻まれる)、ドメインエラー(TeamJobAlreadyQueued 等)が
// 同じ Effect に混在していてもそれらは素通りさせつつ SqlError だけを
// すり替えられる。
export const wrapSqlError = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, Exclude<E, { readonly _tag: "SqlError" }> | RepoError, R> =>
  Effect.catchAll(
    effect,
    (error): Effect.Effect<never, Exclude<E, { readonly _tag: "SqlError" }> | RepoError> =>
      error._tag === "SqlError"
        ? Effect.fail(new RepoError({ cause: error }))
        : Effect.fail(error as Exclude<E, { readonly _tag: "SqlError" }>)
  )

// DB の行(プレーンオブジェクト)からドメインの Schema.Class へ変換する。
// decodeUnknown の ParseError は RepoError にラップする(呼び出し元は DDL と
// Schema の整合が取れている前提でしか呼ばないため、失敗は想定外のバグ扱い)。
export const decodeRow = <A, I, R>(
  schema: Schema.Schema<A, I, R>,
  value: unknown
): Effect.Effect<A, RepoError, R> =>
  Schema.decodeUnknown(schema)(value).pipe(Effect.mapError((cause) => new RepoError({ cause })))

export const optionToNull = <A>(opt: Option.Option<A>): A | null => Option.getOrNull(opt)

export const optionBoolToNullableInt = (opt: Option.Option<boolean>): number | null =>
  Option.match(opt, { onNone: () => null, onSome: (b) => (b ? 1 : 0) })

// 0/1/null 以外は boolean に丸めず生値のまま返し、後段の Schema.decodeUnknown を
// 失敗させる(DB のデータ破損を黙って false に変換しないため)。
export const nullableIntToBool = (n: number | null): boolean | null | number =>
  n === null ? null : n === 1 ? true : n === 0 ? false : n

export const boolToInt = (b: boolean): number => (b ? 1 : 0)
