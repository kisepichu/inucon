import { Effect, Layer } from "effect"

// Task 2 Step 4: fresh DB は「admin が draft を作るまで zero contests」を
// 意図するため、seedIfEmpty は空実装(no-op)にする。Task 1 時点までは
// bench 系テストが preparing 済み contest を期待して INUCON を自動投入して
// いたが、Task 3 で全テストが Contest を明示生成する形に切り替わるため、
// 起動時 seed の役割は無くなった。
//
// Layer 名(SeedLive)と export(seedIfEmpty)は main.ts 側の wiring を
// 温存するために残す(将来 seed が復活したとき差し込みポイントを再利用できる)。
export const seedIfEmpty: Effect.Effect<void> = Effect.void

export const SeedLive = Layer.effectDiscard(seedIfEmpty)
