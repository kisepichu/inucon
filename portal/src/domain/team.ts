import { Schema } from "effect"
import { ContestId, TeamId } from "./ids.js"

// Task 3: Team は contest スコープ。同じ team_number でも異なる contest なら別
// チーム。desiredInstanceCount は Task 5 の draft wizard 以降で意味を持つ設定値
// (第2回想定は 3、既存 legacy は 0004 で「非 deleted の実インスタンス数を
// quota で cap」した値を backfill)。
export class Team extends Schema.Class<Team>("Team")({
  id: TeamId,
  contestId: ContestId,
  name: Schema.String,
  teamNumber: Schema.Number.pipe(Schema.int(), Schema.between(1, 254)),
  desiredInstanceCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative())
}) {}
