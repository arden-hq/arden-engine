import { Schema } from "effect"
import { NonNegativeIntSchema } from "../common/schema.js"

export const BROWSER_SCOPE = { home: "home", space: "space", session: "session" } as const

export const BrowserScopeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(BROWSER_SCOPE.home) }),
  Schema.Struct({ kind: Schema.Literal(BROWSER_SCOPE.space), spaceId: Schema.NonEmptyString })
])
export const BrowserScopeInputSchema = Schema.Union([
  BrowserScopeSchema,
  Schema.Struct({ kind: Schema.Literal(BROWSER_SCOPE.session), sessionId: Schema.NonEmptyString })
])
export const BrowserScopeSnapshotSchema = Schema.Struct({
  revision: NonNegativeIntSchema,
  scope: BrowserScopeSchema,
  sessionIds: Schema.Array(Schema.NonEmptyString)
})
