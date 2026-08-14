import { Effect, Layer, Option } from "effect"
import { Contest } from "../../domain/contest.js"
import { ContestId } from "../../domain/ids.js"
import { ContestRepo, UuidGen } from "../../application/ports.js"

// 起動時シード: contests が空(= まだ save されていない)の場合のみ、
// Phase 2 の唯一のコンテスト "INUCON"(problemKey: private-isu、status:
// preparing、edition 1、template 9100)を 1 件投入する。ContestRepoLive は
// 依然として単一 contest 運用のブリッジ層(Task 3 で解消)なので、
// getCurrent が Option.some を返す場合は何もしない(= 冪等)。
//
// 【Task 2 Step 4 で削除予定】fresh DB は zero contests を意図(admin が draft
// を作るまで空)にするため、Task 2 で seedIfEmpty は撤去される。Task 1 時点は
// 既存挙動を保つ(bench 系テストが preparing 済み contest を期待するため)。
export const seedIfEmpty = Effect.gen(function* () {
  const repo = yield* ContestRepo
  const current = yield* repo.getCurrent
  if (Option.isSome(current)) return

  const uuidGen = yield* UuidGen
  const id = yield* uuidGen.next
  yield* repo.save(
    new Contest({
      id: ContestId.make(id),
      edition: 1,
      name: "INUCON",
      problemKey: "private-isu",
      problemRevision: "legacy-2026-07-08",
      templateVmid: 9100,
      status: "preparing",
      instanceQuota: 3,
      scheduledStartAt: Option.none(),
      scheduledEndAt: Option.none(),
      accessClosesAt: Option.none(),
      cleanupAt: Option.none(),
      accessClosedAt: Option.none(),
      cleanupCompletedAt: Option.none(),
      startedAt: Option.none(),
      finalizingAt: Option.none(),
      finishedAt: Option.none(),
      canceledAt: Option.none(),
      revision: 1
    })
  )
})

// Layer.effectDiscard を使う(TimeoutSweeperLive の Layer.scopedDiscard とは
// 異なり fork しない): シードは起動時に 1 回実行して終わる処理であり、
// バックグラウンドで生き続ける必要がないため。
export const SeedLive = Layer.effectDiscard(seedIfEmpty)
