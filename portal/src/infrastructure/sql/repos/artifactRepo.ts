import { SqlClient } from "@effect/sql"
import { Effect, Layer, Option } from "effect"
import { Artifact } from "../../../domain/artifact.js"
import type { ArtifactId, ContestId } from "../../../domain/ids.js"
import { ArtifactRepo } from "../../../application/ports.js"
import { decodeRow, optionToNull, wrapSqlError } from "./support.js"

// Task 6: contest_artifacts の永続化。regenerate は path/hash/size を差し替えて
// off_host_status を 'pending' に戻す運用のため upsert 化。unique(contest_id,
// kind) が同一種類の重複を防ぐ。
interface ArtifactRow {
  readonly id: string
  readonly contestId: string
  readonly kind: string
  readonly storagePath: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly offHostStatus: string
  readonly verifiedAt: number | null
  readonly createdAt: number
}

const COLUMNS = `
  id, contest_id AS contestId, kind, storage_path AS storagePath,
  sha256, size_bytes AS sizeBytes, off_host_status AS offHostStatus,
  verified_at AS verifiedAt, created_at AS createdAt
`

export const ArtifactRepoLive: Layer.Layer<ArtifactRepo, never, SqlClient.SqlClient> = Layer.effect(
  ArtifactRepo,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const columns = sql.literal(COLUMNS)
    return {
      upsert: (a: Artifact) =>
        wrapSqlError(
          sql`
            INSERT INTO contest_artifacts (
              id, contest_id, kind, storage_path, sha256, size_bytes,
              off_host_status, verified_at, created_at
            ) VALUES (
              ${a.id}, ${a.contestId}, ${a.kind}, ${a.storagePath}, ${a.sha256}, ${a.sizeBytes},
              ${a.offHostStatus}, ${optionToNull(a.verifiedAt)}, ${a.createdAt}
            )
            ON CONFLICT (contest_id, kind) DO UPDATE SET
              storage_path = excluded.storage_path,
              sha256 = excluded.sha256,
              size_bytes = excluded.size_bytes,
              off_host_status = excluded.off_host_status,
              verified_at = excluded.verified_at
          `
        ).pipe(Effect.asVoid),

      listByContest: (contestId: ContestId) =>
        wrapSqlError(
          sql<ArtifactRow>`SELECT ${columns} FROM contest_artifacts WHERE contest_id = ${contestId} ORDER BY kind`
        ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeRow(Artifact, row)))),

      findByKind: (contestId: ContestId, kind: Artifact["kind"]) =>
        wrapSqlError(
          sql<ArtifactRow>`SELECT ${columns} FROM contest_artifacts WHERE contest_id = ${contestId} AND kind = ${kind}`
        ).pipe(
          Effect.flatMap((rows) =>
            rows.length === 0
              ? Effect.succeed(Option.none<Artifact>())
              : decodeRow(Artifact, rows[0]).pipe(Effect.map(Option.some))
          )
        ),

      markVerified: (id: ArtifactId, now: number) =>
        wrapSqlError(
          sql`UPDATE contest_artifacts SET off_host_status = 'verified', verified_at = ${now} WHERE id = ${id}`
        ).pipe(Effect.asVoid)
    }
  })
)
