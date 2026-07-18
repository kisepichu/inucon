import { fileURLToPath } from "node:url"
import { NodeContext } from "@effect/platform-node"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { Config, Layer } from "effect"

export const SqlLive = SqliteClient.layerConfig({
  filename: Config.string("DB_PATH").pipe(Config.withDefault("data/portal.db"))
})

// テスト用など、別の SqlClient Layer に対しても同じマイグレーションを適用できるよう
// loader を単体で公開しておく。
export const migrationsLoader = SqliteMigrator.fromFileSystem(
  fileURLToPath(new URL("migrations", import.meta.url))
)

export const MigratorLive = SqliteMigrator.layer({ loader: migrationsLoader }).pipe(
  Layer.provide(SqlLive),
  Layer.provide(NodeContext.layer)
)
