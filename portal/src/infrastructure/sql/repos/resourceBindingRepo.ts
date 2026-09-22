import { SqlClient } from "@effect/sql"
import { Effect, Layer } from "effect"
import type { ContestId, ResourceBindingId } from "../../../domain/ids.js"
import { ResourceBinding } from "../../../domain/resourceBinding.js"
import { ResourceBindingRepo } from "../../../application/ports.js"
import { decodeRow, optionToNull, wrapSqlError } from "./support.js"

// Task 6: ResourceBinding の永続化。plan_apply がここに upsert し、
// reconciliation が listByContest で観測。unique(provider,resource_type,
// canonical_key) は migration 0006 で強制。
interface BindingRow {
  readonly id: string
  readonly contestId: string
  readonly teamId: string | null
  readonly instanceId: string | null
  readonly provider: string
  readonly resourceType: string
  readonly canonicalKey: string
  readonly externalId: string | null
  readonly desiredState: string
  readonly lastObservedState: string | null
  readonly lastObservedAt: number | null
}

const COLUMNS = `
  id, contest_id AS contestId, team_id AS teamId, instance_id AS instanceId,
  provider, resource_type AS resourceType, canonical_key AS canonicalKey,
  external_id AS externalId, desired_state AS desiredState,
  last_observed_state AS lastObservedState, last_observed_at AS lastObservedAt
`

export const ResourceBindingRepoLive: Layer.Layer<
  ResourceBindingRepo,
  never,
  SqlClient.SqlClient
> = Layer.effect(
  ResourceBindingRepo,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const columns = sql.literal(COLUMNS)
    return {
      upsert: (b: ResourceBinding) =>
        wrapSqlError(
          sql`
            INSERT INTO resource_bindings (
              id, contest_id, team_id, instance_id, provider, resource_type,
              canonical_key, external_id, desired_state,
              last_observed_state, last_observed_at
            ) VALUES (
              ${b.id}, ${b.contestId}, ${optionToNull(b.teamId)}, ${optionToNull(b.instanceId)},
              ${b.provider}, ${b.resourceType},
              ${b.canonicalKey}, ${optionToNull(b.externalId)}, ${b.desiredState},
              ${optionToNull(b.lastObservedState)}, ${optionToNull(b.lastObservedAt)}
            )
            ON CONFLICT (provider, resource_type, canonical_key) DO UPDATE SET
              contest_id = excluded.contest_id,
              team_id = excluded.team_id,
              instance_id = excluded.instance_id,
              external_id = excluded.external_id,
              desired_state = excluded.desired_state,
              last_observed_state = excluded.last_observed_state,
              last_observed_at = excluded.last_observed_at
          `
        ).pipe(Effect.asVoid),

      listByContest: (contestId: ContestId) =>
        wrapSqlError(
          sql<BindingRow>`SELECT ${columns} FROM resource_bindings WHERE contest_id = ${contestId}`
        ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeRow(ResourceBinding, row)))),

      deleteById: (id: ResourceBindingId) =>
        wrapSqlError(sql`DELETE FROM resource_bindings WHERE id = ${id}`).pipe(Effect.asVoid)
    }
  })
)
