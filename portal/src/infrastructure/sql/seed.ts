import { Effect, Layer, Option } from "effect"
import { Contest } from "../../domain/contest.js"
import { ContestId } from "../../domain/ids.js"
import { ContestRepo, UuidGen } from "../../application/ports.js"

// 起動時シード(Task 11): contests が空(= まだ save されていない)の場合のみ、
// Phase 2 で運用する唯一のコンテスト "INUCON"(problemKey: private-isu、
// status: preparing)を 1 件投入する。ContestRepoLive は単一コンテスト運用
// (contests テーブルは常に高々 1 行)を前提にしているため、getCurrent が
// Option.some を返す場合は何もしない(= 冪等。2 回目以降の起動では増えない)。
//
// Effect 本体を単独 export しておく(テストで Layer 構築のタイミングに縛られず
// 「空なら入る」「既にあれば増えない」を直接検証できるようにするため)。
export const seedIfEmpty = Effect.gen(function* () {
  const repo = yield* ContestRepo
  const current = yield* repo.getCurrent
  if (Option.isSome(current)) return

  const uuidGen = yield* UuidGen
  const id = yield* uuidGen.next
  yield* repo.save(
    new Contest({
      id: ContestId.make(id),
      name: "INUCON",
      problemKey: "private-isu",
      status: "preparing",
      instanceQuota: 3
    })
  )
})

// Layer.effectDiscard を使う(TimeoutSweeperLive の Layer.scopedDiscard とは
// 異なり fork しない): シードは起動時に 1 回実行して終わる処理であり、
// バックグラウンドで生き続ける必要がないため。
export const SeedLive = Layer.effectDiscard(seedIfEmpty)
