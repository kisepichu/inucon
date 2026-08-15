import { SqlClient } from "@effect/sql"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import migration0001 from "../../src/infrastructure/sql/migrations/0001_initial.js"
import migration0002 from "../../src/infrastructure/sql/migrations/0002_selfservice.js"
import migration0003 from "../../src/infrastructure/sql/migrations/0003_failed_reserves_slot.js"
import migration0004 from "../../src/infrastructure/sql/migrations/0004_contest_lifecycle.js"
import migration0005 from "../../src/infrastructure/sql/migrations/0005_multi_contest.js"
import migration0006 from "../../src/infrastructure/sql/migrations/0006_operations.js"
import { SqlTest } from "../support/sqlTest.js"

// migration 0001-0005 → 0006 の適用結果を狙い撃ちで確認する。各 it.layer
// ブロックが :memory: DB を独立に構築するため 1 テスト = 1 it.layer 構成にする
// (同一 DB 上で migration を二度走らせると "table users already exists" になる)。

const seedContest = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      INSERT INTO contests (
        id, edition, name, problem_key, problem_revision, template_vmid,
        status, instance_quota, revision
      ) VALUES (${id}, 1, 'INUCON', 'private-isu', 'legacy-2026-07-08', 9100, 'preparing', 3, 1)
    `
  })

const applyAll = Effect.gen(function* () {
  yield* migration0001
  yield* migration0002
  yield* migration0003
  yield* migration0004
  yield* migration0005
  yield* migration0006
})

it.layer(SqlTest)("migration 0006: operations table shape", (it) => {
  it.effect("required columns present", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* applyAll
      const cols = yield* sql<{ name: string }>`PRAGMA table_info(operations)`
      const names = cols.map((c) => c.name).sort()
      expect(names).toEqual(
        [
          "id",
          "contest_id",
          "kind",
          "status",
          "actor_kind",
          "actor_user_id",
          "plan_digest",
          "contest_revision",
          "sanitized_error",
          "created_at",
          "started_at",
          "finished_at"
        ].sort()
      )
    })
  )
})

it.layer(SqlTest)("migration 0006: operation_steps table shape", (it) => {
  it.effect("required columns present", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* applyAll
      const cols = yield* sql<{ name: string }>`PRAGMA table_info(operation_steps)`
      const names = cols.map((c) => c.name).sort()
      expect(names).toEqual(
        [
          "id",
          "operation_id",
          "ordinal",
          "step_key",
          "status",
          "attempt",
          "continue_on_error",
          "retry_at",
          "lease_expires_at",
          "input_summary",
          "progress_json",
          "result_summary",
          "sanitized_error",
          "created_at",
          "started_at",
          "finished_at"
        ].sort()
      )
    })
  )
})

it.layer(SqlTest)("migration 0006: resource_bindings / contest_artifacts / runner_agents shapes", (it) => {
  it.effect("all three ownership tables exist with expected columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* applyAll
      const bindingCols = yield* sql<{ name: string }>`PRAGMA table_info(resource_bindings)`
      expect(bindingCols.map((c) => c.name).sort()).toEqual(
        [
          "id",
          "contest_id",
          "team_id",
          "instance_id",
          "provider",
          "resource_type",
          "canonical_key",
          "external_id",
          "desired_state",
          "last_observed_state",
          "last_observed_at"
        ].sort()
      )
      const artifactCols = yield* sql<{ name: string }>`PRAGMA table_info(contest_artifacts)`
      expect(artifactCols.map((c) => c.name).sort()).toEqual(
        [
          "id",
          "contest_id",
          "kind",
          "storage_path",
          "sha256",
          "size_bytes",
          "off_host_status",
          "verified_at",
          "created_at"
        ].sort()
      )
      const runnerCols = yield* sql<{ name: string }>`PRAGMA table_info(runner_agents)`
      expect(runnerCols.map((c) => c.name).sort()).toEqual(
        ["id", "revision", "bench_ready", "health_summary", "last_seen_at"].sort()
      )
    })
  )
})

it.layer(SqlTest)("migration 0006: partial unique index enforces one unfinished Operation", (it) => {
  it.effect("succeeded/canceled release the lock; queued/running/failed/blocked retain it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* applyAll
      yield* seedContest("c-op-1")

      yield* sql`
        INSERT INTO operations (id, contest_id, kind, status, actor_kind, plan_digest, contest_revision, created_at)
        VALUES ('op-a', 'c-op-1', 'prepare', 'queued', 'scheduler', 'digest-a', 1, 0)
      `

      const dup = yield* Effect.exit(sql`
        INSERT INTO operations (id, contest_id, kind, status, actor_kind, plan_digest, contest_revision, created_at)
        VALUES ('op-b', 'c-op-1', 'prepare', 'queued', 'scheduler', 'digest-b', 1, 0)
      `)
      expect(dup._tag).toBe("Failure")

      yield* sql`UPDATE operations SET status = 'succeeded', finished_at = 1 WHERE id = 'op-a'`
      yield* sql`
        INSERT INTO operations (id, contest_id, kind, status, actor_kind, plan_digest, contest_revision, created_at)
        VALUES ('op-b', 'c-op-1', 'prepare', 'queued', 'scheduler', 'digest-b', 1, 2)
      `

      yield* sql`UPDATE operations SET status = 'failed' WHERE id = 'op-b'`
      const whileFailed = yield* Effect.exit(sql`
        INSERT INTO operations (id, contest_id, kind, status, actor_kind, plan_digest, contest_revision, created_at)
        VALUES ('op-c', 'c-op-1', 'prepare', 'queued', 'scheduler', 'digest-c', 1, 3)
      `)
      expect(whileFailed._tag).toBe("Failure")

      yield* sql`UPDATE operations SET status = 'canceled', finished_at = 4 WHERE id = 'op-b'`
      const okAfterCancel = yield* Effect.exit(sql`
        INSERT INTO operations (id, contest_id, kind, status, actor_kind, plan_digest, contest_revision, created_at)
        VALUES ('op-c', 'c-op-1', 'prepare', 'queued', 'scheduler', 'digest-c', 1, 5)
      `)
      expect(okAfterCancel._tag).toBe("Success")
    })
  )
})

it.layer(SqlTest)("migration 0006: CHECK constraints — kind/status/actor_kind", (it) => {
  it.effect("bad enum values and missing admin user id are rejected", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* applyAll
      yield* seedContest("c-check-1")

      const badKind = yield* Effect.exit(sql`
        INSERT INTO operations (id, contest_id, kind, status, actor_kind, plan_digest, contest_revision, created_at)
        VALUES ('op-x', 'c-check-1', 'no-such', 'queued', 'scheduler', 'd', 1, 0)
      `)
      expect(badKind._tag).toBe("Failure")

      const badStatus = yield* Effect.exit(sql`
        INSERT INTO operations (id, contest_id, kind, status, actor_kind, plan_digest, contest_revision, created_at)
        VALUES ('op-y', 'c-check-1', 'prepare', 'no-such', 'scheduler', 'd', 1, 0)
      `)
      expect(badStatus._tag).toBe("Failure")

      const adminMissingUser = yield* Effect.exit(sql`
        INSERT INTO operations (id, contest_id, kind, status, actor_kind, plan_digest, contest_revision, created_at)
        VALUES ('op-z', 'c-check-1', 'prepare', 'queued', 'admin', 'd', 1, 0)
      `)
      expect(adminMissingUser._tag).toBe("Failure")
    })
  )
})

it.layer(SqlTest)("migration 0006: CHECK constraints — steps json_valid + status", (it) => {
  it.effect("progress_json must be valid JSON; step status enum enforced", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* applyAll
      yield* seedContest("c-json-1")
      yield* sql`
        INSERT INTO operations (id, contest_id, kind, status, actor_kind, plan_digest, contest_revision, created_at)
        VALUES ('op-json', 'c-json-1', 'prepare', 'queued', 'scheduler', 'd', 1, 0)
      `

      const badJson = yield* Effect.exit(sql`
        INSERT INTO operation_steps
          (id, operation_id, ordinal, step_key, status, attempt, continue_on_error, input_summary, progress_json, created_at)
        VALUES ('step-x', 'op-json', 0, 'k', 'queued', 0, 0, '', '{not json}', 0)
      `)
      expect(badJson._tag).toBe("Failure")

      const badStatus = yield* Effect.exit(sql`
        INSERT INTO operation_steps
          (id, operation_id, ordinal, step_key, status, attempt, continue_on_error, input_summary, progress_json, created_at)
        VALUES ('step-y', 'op-json', 0, 'k', 'no-such', 0, 0, '', '{}', 0)
      `)
      expect(badStatus._tag).toBe("Failure")
    })
  )
})

it.layer(SqlTest)("migration 0006: unique (operation_id, ordinal) and (operation_id, step_key)", (it) => {
  it.effect("duplicate ordinal or step_key inside one operation is rejected", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* applyAll
      yield* seedContest("c-step-uni")
      yield* sql`
        INSERT INTO operations (id, contest_id, kind, status, actor_kind, plan_digest, contest_revision, created_at)
        VALUES ('op-u', 'c-step-uni', 'prepare', 'queued', 'scheduler', 'd', 1, 0)
      `
      yield* sql`
        INSERT INTO operation_steps
          (id, operation_id, ordinal, step_key, status, attempt, continue_on_error, input_summary, progress_json, created_at)
        VALUES ('s-1', 'op-u', 0, 'a', 'queued', 0, 0, '', '{}', 0)
      `
      const dupOrdinal = yield* Effect.exit(sql`
        INSERT INTO operation_steps
          (id, operation_id, ordinal, step_key, status, attempt, continue_on_error, input_summary, progress_json, created_at)
        VALUES ('s-2', 'op-u', 0, 'b', 'queued', 0, 0, '', '{}', 0)
      `)
      expect(dupOrdinal._tag).toBe("Failure")

      const dupKey = yield* Effect.exit(sql`
        INSERT INTO operation_steps
          (id, operation_id, ordinal, step_key, status, attempt, continue_on_error, input_summary, progress_json, created_at)
        VALUES ('s-3', 'op-u', 1, 'a', 'queued', 0, 0, '', '{}', 0)
      `)
      expect(dupKey._tag).toBe("Failure")
    })
  )
})

it.layer(SqlTest)("migration 0006: unique (provider, resource_type, canonical_key) for bindings", (it) => {
  it.effect("duplicate canonical key rejected", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* applyAll
      yield* seedContest("c-b-1")
      yield* sql`
        INSERT INTO resource_bindings (id, contest_id, provider, resource_type, canonical_key, desired_state)
        VALUES ('b-1', 'c-b-1', 'cloudflare', 'dns_record', 'team1-1.example.com', 'present')
      `
      const dup = yield* Effect.exit(sql`
        INSERT INTO resource_bindings (id, contest_id, provider, resource_type, canonical_key, desired_state)
        VALUES ('b-2', 'c-b-1', 'cloudflare', 'dns_record', 'team1-1.example.com', 'present')
      `)
      expect(dup._tag).toBe("Failure")
    })
  )
})

it.layer(SqlTest)("migration 0006: contest_artifacts (contest_id, kind) unique + off_host_status CHECK", (it) => {
  it.effect("duplicate (contest, kind) rejected; off_host_status enum enforced", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* applyAll
      yield* seedContest("c-art-1")
      yield* sql`
        INSERT INTO contest_artifacts
          (id, contest_id, kind, storage_path, sha256, size_bytes, off_host_status, created_at)
        VALUES ('a-1', 'c-art-1', 'scoreboard', '/backups/x.json', 'sha', 1, 'pending', 0)
      `
      const dup = yield* Effect.exit(sql`
        INSERT INTO contest_artifacts
          (id, contest_id, kind, storage_path, sha256, size_bytes, off_host_status, created_at)
        VALUES ('a-2', 'c-art-1', 'scoreboard', '/backups/y.json', 'sha', 1, 'pending', 0)
      `)
      expect(dup._tag).toBe("Failure")

      const badOffHost = yield* Effect.exit(sql`
        INSERT INTO contest_artifacts
          (id, contest_id, kind, storage_path, sha256, size_bytes, off_host_status, created_at)
        VALUES ('a-3', 'c-art-1', 'snapshot', '/backups/y.json', 'sha', 1, 'ok', 0)
      `)
      expect(badOffHost._tag).toBe("Failure")
    })
  )
})

it.layer(SqlTest)("migration 0006: runner_agents health_summary length limit", (it) => {
  it.effect("length > 256 rejected", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* applyAll
      const long = "x".repeat(257)
      const bad = yield* Effect.exit(sql`
        INSERT INTO runner_agents (id, revision, bench_ready, health_summary, last_seen_at)
        VALUES ('r-1', 1, 1, ${long}, 0)
      `)
      expect(bad._tag).toBe("Failure")
    })
  )
})
