import { Schema } from "effect"
import { TeamId } from "./ids.js"

export class Team extends Schema.Class<Team>("Team")({
  id: TeamId,
  name: Schema.String,
  teamNumber: Schema.Number.pipe(Schema.int(), Schema.between(1, 254))
}) {}
