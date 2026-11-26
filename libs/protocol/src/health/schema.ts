import { Schema } from "effect"
import { HEALTH_STATUS_VALUE, type HealthStatus } from "./contracts.js"

export const HealthResponseSchema = Schema.Struct({
  status: Schema.Literals(Object.values(HEALTH_STATUS_VALUE)),
  version: Schema.String,
  has_providers: Schema.Boolean
})

export const toHealthStatus = (health: typeof HealthResponseSchema.Type): HealthStatus => ({
  status: health.status,
  version: health.version,
  hasProviders: health.has_providers
})
