import { Schema } from "effect"
import type { HealthStatus } from "./contracts.js"

/** Safe server response. */
export const HealthResponseSchema = Schema.Struct({
  status: Schema.Literals(["ok", "unavailable"] as const),
  version: Schema.String,
  has_providers: Schema.Boolean
})

/** The public projection: authentication, storage and outbox internals stay out. */
export const toHealthStatus = (health: typeof HealthResponseSchema.Type): HealthStatus => ({
  status: health.status,
  version: health.version,
  hasProviders: health.has_providers
})
