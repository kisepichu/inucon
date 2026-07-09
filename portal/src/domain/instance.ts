import { Schema } from "effect"
import { InstanceId, TeamId } from "./ids.js"

export class Instance extends Schema.Class<Instance>("Instance")({
  id: InstanceId,
  teamId: TeamId,
  index: Schema.Int.pipe(Schema.positive()),
  privateIp: Schema.String,
  status: Schema.Literal("active")
}) {}
