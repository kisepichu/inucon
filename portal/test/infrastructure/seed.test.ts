import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { expect } from "vitest"
import { ContestRepo } from "../../src/application/ports.js"
import { ContestRepoLive } from "../../src/infrastructure/sql/repos/contestRepo.js"
import { seedIfEmpty } from "../../src/infrastructure/sql/seed.js"
import { UuidGenLive } from "../../src/infrastructure/sql/uuid.js"
import { MigratorTest, SqlTest } from "../support/sqlTest.js"

// Task 2 Step 4: fresh DB は zero contests を意図する(admin が draft を作る
// まで空)ため、seedIfEmpty は no-op になった。ここでは「seed を何度呼んでも
// contests が空のまま」を回帰として確認する。
const RepoLayer = Layer.mergeAll(ContestRepoLive).pipe(
  Layer.provideMerge(UuidGenLive),
  Layer.provideMerge(MigratorTest),
  Layer.provideMerge(SqlTest)
)

const layer = it.layer(RepoLayer)

layer("seedIfEmpty は no-op", (it) => {
  it.effect("seed 前後で contests は空のまま", () =>
    Effect.gen(function* () {
      const repo = yield* ContestRepo
      expect((yield* repo.list).length).toBe(0)

      yield* seedIfEmpty
      yield* seedIfEmpty

      expect((yield* repo.list).length).toBe(0)
    })
  )
})
