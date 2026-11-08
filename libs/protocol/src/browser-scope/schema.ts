import { Schema } from "effect"
import { NonNegativeIntSchema } from "../common/schema.js"

export const BrowserScopeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("home") }),
  Schema.Struct({ kind: Schema.Literal("space"), spaceId: Schema.NonEmptyString })
])
export const BrowserScopeInputSchema = Schema.Union([
  BrowserScopeSchema,
  Schema.Struct({ kind: Schema.Literal("session"), sessionId: Schema.NonEmptyString })
])
export const BrowserScopeSnapshotSchema = Schema.Struct({
  revision: NonNegativeIntSchema,
  scope: BrowserScopeSchema,
  sessionIds: Schema.Array(Schema.NonEmptyString)
})
