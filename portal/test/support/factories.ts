import { Option } from "effect"
import { Contest } from "../../src/domain/contest.js"
import { ContestId } from "../../src/domain/ids.js"

// Task 1: Contest スキーマが 20 フィールドに拡大したため、テストでは常に
// makeContest(overrides) を経由して既定値を注入する。既定は「draft と互換な
// スケジュール未設定・revision=1」で、既存テスト側は必要なフィールドだけ
// overrides で上書きする(status を preparing/running/finished にする、
// instanceQuota を変える、等)。
//
// 【重要】production の Contest schema は positive/branded 制約をすべて保持した
// まま。この factory は「テストの記述負荷を減らす」ためだけの Test Data Builder
// であり、schema そのものは緩めない(spec §「境界 Schema は緩めない」)。
export type MakeContestOverrides = Partial<Omit<Contest, "id">> & { id?: Contest["id"] }

let contestSeq = 0

const nextContestId = (): Contest["id"] => {
  contestSeq += 1
  return ContestId.make(`00000000-0000-0000-0000-${String(contestSeq).padStart(12, "0")}`)
}

export const makeContest = (overrides: MakeContestOverrides = {}): Contest =>
  new Contest({
    id: overrides.id ?? nextContestId(),
    edition: overrides.edition ?? 1,
    name: overrides.name ?? "INUCON",
    problemKey: overrides.problemKey ?? "private-isu",
    problemRevision: overrides.problemRevision ?? "legacy-2026-07-08",
    templateVmid: overrides.templateVmid ?? 9100,
    status: overrides.status ?? "draft",
    instanceQuota: overrides.instanceQuota ?? 3,
    scheduledStartAt: overrides.scheduledStartAt ?? Option.none(),
    scheduledEndAt: overrides.scheduledEndAt ?? Option.none(),
    accessClosesAt: overrides.accessClosesAt ?? Option.none(),
    cleanupAt: overrides.cleanupAt ?? Option.none(),
    accessClosedAt: overrides.accessClosedAt ?? Option.none(),
    cleanupCompletedAt: overrides.cleanupCompletedAt ?? Option.none(),
    startedAt: overrides.startedAt ?? Option.none(),
    finalizingAt: overrides.finalizingAt ?? Option.none(),
    finishedAt: overrides.finishedAt ?? Option.none(),
    canceledAt: overrides.canceledAt ?? Option.none(),
    revision: overrides.revision ?? 1
  })
