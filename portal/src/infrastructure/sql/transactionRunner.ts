import { SqlClient } from "@effect/sql"
import { Effect, Layer } from "effect"
import { RepoError, TransactionRunner } from "../../application/ports.js"

// Task 5 review finding 3: 複数リポジトリの read/write を 1 トランザクションで
// 括るための SQL 実装。sql.withTransaction は SqlError を後付けするため、
// ここで SqlError を RepoError へ畳んで呼び出し元の error 型を安定させる。
export const TransactionRunnerLive: Layer.Layer<TransactionRunner, never, SqlClient.SqlClient> =
  Layer.effect(
    TransactionRunner,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return {
        run: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          sql
            .withTransaction(effect)
            .pipe(Effect.catchTag("SqlError", (cause) => Effect.fail(new RepoError({ cause }))))
      }
    })
  )
