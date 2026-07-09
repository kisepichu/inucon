import { NodeContext } from "@effect/platform-node"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { Layer } from "effect"
import { migrationsLoader } from "../../src/infrastructure/sql/client.js"

// テスト用: `:memory:` の SQLite + 本番と同一のマイグレーションを適用した Layer。
export const SqlTest = SqliteClient.layer({ filename: ":memory:" })

export const MigratorTest = SqliteMigrator.layer({ loader: migrationsLoader }).pipe(
  Layer.provide(SqlTest),
  Layer.provide(NodeContext.layer)
)
