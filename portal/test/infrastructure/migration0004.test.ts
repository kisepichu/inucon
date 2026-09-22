import { SqlClient } from "@effect/sql"
import { it } from "@effect/vitest"
import { Cause, Effect, Option } from "effect"
import { expect } from "vitest"
import migration0001 from "../../src/infrastructure/sql/migrations/0001_initial.js"
import migration0002 from "../../src/infrastructure/sql/migrations/0002_selfservice.js"
import migration0003 from "../../src/infrastructure/sql/migrations/0003_failed_reserves_slot.js"
import migration0004 from "../../src/infrastructure/sql/migrations/0004_contest_lifecycle.js"
import { SqlTest } from "../support/sqlTest.js"

// migration0002/0003.test.ts と同じ方針(brief 参照): 各 migration の default export
// を順に適用して「0004 適用後の最終状態」だけを狙い撃ちで検証する。0004 は
// contests テーブルを完全な形へ再構築し、legacy 1 行を edition=1 / template=9100 /
// problem_revision='legacy-2026-07-08' に backfill、edition の partial unique と
// single-operational partial unique を張る。

const insertLegacyContest = (
  sql: SqlClient.SqlClient,
  args: { id: string; name?: string; problemKey?: string; status?: string; instanceQuota?: number }
) =>
  sql`
    INSERT INTO contests (id, name, problem_key, status, instance_quota)
    VALUES (
      ${args.id},
      ${args.name ?? "INUCON"},
      ${args.problemKey ?? "private-isu"},
      ${args.status ?? "finished"},
      ${args.instanceQuota ?? 3}
    )
  `

it.layer(SqlTest)(
  "migration 0004: legacy 1 行があるとき edition=1 / template=9100 / legacy-2026-07-08 に backfill する",
  (it) => {
    it.effect("id/name/problemKey/status/instanceQuota を保持し、schedule/timestamps は NULL、revision=1 になる", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* migration0001
        yield* migration0002
        yield* migration0003
        yield* insertLegacyContest(sql, {
          id: "contest-legacy-1",
          name: "INUCON",
          problemKey: "private-isu",
          status: "finished",
          instanceQuota: 3
        })

        yield* migration0004

        const rows = yield* sql<{
          id: string
          edition: number
          name: string
          problem_key: string
          problem_revision: string
          template_vmid: number
          status: string
          instance_quota: number
          scheduled_start_at: number | null
          scheduled_end_at: number | null
          access_closes_at: number | null
          cleanup_at: number | null
          access_closed_at: number | null
          cleanup_completed_at: number | null
          started_at: number | null
          finalizing_at: number | null
          finished_at: number | null
          canceled_at: number | null
          revision: number
        }>`SELECT * FROM contests`

        expect(rows).toHaveLength(1)
        expect(rows[0]).toStrictEqual({
          id: "contest-legacy-1",
          edition: 1,
          name: "INUCON",
          problem_key: "private-isu",
          problem_revision: "legacy-2026-07-08",
          template_vmid: 9100,
          status: "finished",
          instance_quota: 3,
          scheduled_start_at: null,
          scheduled_end_at: null,
          access_closes_at: null,
          cleanup_at: null,
          access_closed_at: null,
          cleanup_completed_at: null,
          started_at: null,
          finalizing_at: null,
          finished_at: null,
          canceled_at: null,
          revision: 1
        })
      })
    )
  }
)

it.layer(SqlTest)(
  "migration 0004: 0 行のフレッシュ DB では空の新テーブルを作る",
  (it) => {
    it.effect("contests は 0 行、schema は draft/canceled を含む拡張済み", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* migration0001
        yield* migration0002
        yield* migration0003
        yield* migration0004

        const [{ n }] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM contests`
        expect(n).toBe(0)

        // draft を挿入できる(0001 の CHECK には無かった)。
        const insertDraft = yield* Effect.exit(
          sql`
            INSERT INTO contests (
              id, edition, name, problem_key, problem_revision, template_vmid,
              status, instance_quota, revision
            ) VALUES ('c-draft-1', 1, 'X', 'private-isu', 'legacy-2026-07-08', 9100, 'draft', 3, 1)
          `
        )
        expect(insertDraft._tag).toBe("Success")

        // canceled も挿入できる(status CHECK 拡張の確認)。
        const insertCanceled = yield* Effect.exit(
          sql`
            INSERT INTO contests (
              id, edition, name, problem_key, problem_revision, template_vmid,
              status, instance_quota, revision
            ) VALUES ('c-canceled-1', 2, 'X', 'private-isu', 'legacy-2026-07-08', 9100, 'canceled', 3, 1)
          `
        )
        expect(insertCanceled._tag).toBe("Success")
      })
    )
  }
)

it.layer(SqlTest)(
  "migration 0004: legacy が 2 行以上あると MigrationDataError で中断する",
  (it) => {
    it.effect("行数不一致は defect ではなく failure として観測できる", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* migration0001
        yield* migration0002
        yield* migration0003
        yield* insertLegacyContest(sql, { id: "contest-legacy-a" })
        yield* insertLegacyContest(sql, { id: "contest-legacy-b" })

        const exit = yield* Effect.exit(sql.withTransaction(migration0004))
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          const err = Cause.failureOption(exit.cause)
          expect(Option.isSome(err)).toBe(true)
          if (Option.isSome(err) && typeof err.value === "object" && err.value !== null && "_tag" in err.value) {
            expect(err.value._tag).toBe("MigrationDataError")
          }
        }

        // ロールバックにより contests は 0002/0003 の元スキーマのまま残る
        // (edition 列は存在しない)。
        const cols = yield* sql<{ name: string }>`PRAGMA table_info(contests)`
        const columnNames = cols.map((c) => c.name).sort()
        expect(columnNames).toEqual(["id", "instance_quota", "name", "problem_key", "status"].sort())
      })
    )
  }
)

it.layer(SqlTest)(
  "migration 0004: partial unique index が edition と single-operational を強制する",
  (it) => {
    it.effect("canceled は edition を消費しない・preparing/running/finalizing は 1 行のみ", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* migration0001
        yield* migration0002
        yield* migration0003
        yield* migration0004

        // 同一 edition の canceled は許可、両方 live は拒否。
        yield* sql`
          INSERT INTO contests (
            id, edition, name, problem_key, problem_revision, template_vmid,
            status, instance_quota, revision
          ) VALUES ('c-e5-canceled', 5, 'X', 'private-isu', 'legacy-2026-07-08', 9100, 'canceled', 3, 1)
        `
        const okReuse = yield* Effect.exit(
          sql`
            INSERT INTO contests (
              id, edition, name, problem_key, problem_revision, template_vmid,
              status, instance_quota, revision
            ) VALUES ('c-e5-draft', 5, 'X', 'private-isu', 'legacy-2026-07-08', 9100, 'draft', 3, 1)
          `
        )
        expect(okReuse._tag).toBe("Success")

        const conflictLive = yield* Effect.exit(
          sql`
            INSERT INTO contests (
              id, edition, name, problem_key, problem_revision, template_vmid,
              status, instance_quota, revision
            ) VALUES ('c-e5-draft-dup', 5, 'X', 'private-isu', 'legacy-2026-07-08', 9100, 'draft', 3, 1)
          `
        )
        expect(conflictLive._tag).toBe("Failure")

        // 2 つ目の preparing はブロックされる。draft は複数 OK。
        yield* sql`
          INSERT INTO contests (
            id, edition, name, problem_key, problem_revision, template_vmid,
            status, instance_quota, revision
          ) VALUES ('c-e6-prep', 6, 'X', 'private-isu', 'legacy-2026-07-08', 9100, 'preparing', 3, 1)
        `
        const secondPreparing = yield* Effect.exit(
          sql`
            INSERT INTO contests (
              id, edition, name, problem_key, problem_revision, template_vmid,
              status, instance_quota, revision
            ) VALUES ('c-e7-prep', 7, 'X', 'private-isu', 'legacy-2026-07-08', 9100, 'preparing', 3, 1)
          `
        )
        expect(secondPreparing._tag).toBe("Failure")
      })
    )
  }
)
