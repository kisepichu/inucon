import { it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { expect } from "vitest"
import { Contest } from "../../src/domain/contest.js"
import { ContestId } from "../../src/domain/ids.js"
import { ContestRepo } from "../../src/application/ports.js"
import { ContestRepoLive } from "../../src/infrastructure/sql/repos/contestRepo.js"
import { seedIfEmpty } from "../../src/infrastructure/sql/seed.js"
import { UuidGenLive } from "../../src/infrastructure/sql/uuid.js"
import { MigratorTest, SqlTest } from "../support/sqlTest.js"

// seedIfEmpty を直接 Effect として検証する(Layer 構築タイミングに依存せず、
// 「空なら入る」「既にあれば増えない」の両方を it.layer の 1 テスト内で
// 素直に書けるようにするため。SeedLive 自体は seedIfEmpty を
// Layer.effectDiscard で包んだだけの薄いラッパー)。
const RepoLayer = Layer.mergeAll(ContestRepoLive).pipe(
  Layer.provideMerge(UuidGenLive),
  Layer.provideMerge(MigratorTest),
  Layer.provideMerge(SqlTest)
)

const layer = it.layer(RepoLayer)

layer("seedIfEmpty", (it) => {
  it.effect("contests が空なら INUCON/private-isu/preparing を 1 件投入する", () =>
    Effect.gen(function* () {
      const repo = yield* ContestRepo
      expect(yield* repo.getCurrent).toStrictEqual(Option.none())

      yield* seedIfEmpty

      const current = yield* repo.getCurrent
      expect(Option.isSome(current)).toBe(true)
      if (Option.isSome(current)) {
        expect(current.value.name).toBe("INUCON")
        expect(current.value.problemKey).toBe("private-isu")
        expect(current.value.status).toBe("preparing")
      }
    })
  )

  it.effect("既に contest があれば増えない(既存行を上書きしない)", () =>
    Effect.gen(function* () {
      const repo = yield* ContestRepo
      const existing = new Contest({
        id: ContestId.make("contest-existing"),
        name: "既存コンテスト",
        problemKey: "existing-problem",
        status: "running"
      })
      yield* repo.save(existing)

      yield* seedIfEmpty

      const current = yield* repo.getCurrent
      expect(current).toStrictEqual(Option.some(existing))
    })
  )
})
