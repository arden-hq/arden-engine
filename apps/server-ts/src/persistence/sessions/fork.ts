import { Schema } from "effect"

export const StoredForkSchema = Schema.Struct({
  at: Schema.NonEmptyString,
  turn_id: Schema.NonEmptyString
})

export type StoredFork = (typeof StoredForkSchema)["Type"]
