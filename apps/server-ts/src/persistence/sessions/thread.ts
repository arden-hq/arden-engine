import { Schema } from "effect"

export const StoredThreadSchema = Schema.Struct({
  source_session_id: Schema.NonEmptyString,
  source_session_ref: Schema.optionalKey(Schema.NonEmptyString),
  source_turn_id: Schema.NonEmptyString,
  purpose: Schema.NonEmptyString,
  starts_with: Schema.Array(Schema.String)
})

export type StoredThread = (typeof StoredThreadSchema)["Type"]
