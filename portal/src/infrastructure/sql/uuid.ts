import { randomUUID } from "node:crypto"
import { Effect, Layer } from "effect"
import { UuidGen } from "../../application/ports.js"

export const UuidGenLive: Layer.Layer<UuidGen> = Layer.succeed(UuidGen, {
  next: Effect.sync(() => randomUUID())
})
