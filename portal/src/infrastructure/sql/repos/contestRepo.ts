import { SqlClient } from "@effect/sql"
import { Effect, Layer, Option } from "effect"
import { Contest } from "../../../domain/contest.js"
import { ContestRepo } from "../../../application/ports.js"
import { decodeRow, wrapSqlError } from "./support.js"

// 単一コンテスト運用: 「現在のコンテスト」はテーブル上つねに高々 1 行。
// save は既存行をすべて削除して置き換える(in-memory 参照実装の
// Ref.set(ref, Option.some(c)) と同じ「全体を上書きする」意味論)。
export const ContestRepoLive: Layer.Layer<ContestRepo, never, SqlClient.SqlClient> = Layer.effect(
  ContestRepo,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return {
      getCurrent: wrapSqlError(
        sql<{ id: string; name: string; problemKey: string; status: string; instanceQuota: number }>`
          SELECT id, name, problem_key AS problemKey, status, instance_quota AS instanceQuota FROM contests LIMIT 1
        `
      ).pipe(
        Effect.flatMap((rows) =>
          rows.length === 0
            ? Effect.succeed(Option.none<Contest>())
            : decodeRow(Contest, rows[0]).pipe(Effect.map(Option.some))
        )
      ),

      save: (c: Contest) =>
        wrapSqlError(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM contests`
              yield* sql`
                INSERT INTO contests (id, name, problem_key, status, instance_quota)
                VALUES (${c.id}, ${c.name}, ${c.problemKey}, ${c.status}, ${c.instanceQuota})
              `
            })
          )
        )
    }
  })
)
