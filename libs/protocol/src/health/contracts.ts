import type { JsonRecord } from "../common/json.js"

export type HealthStatusValue = "ok" | "unavailable"

/** Sanitized startup projection. Auth, storage, outbox, and raw errors are private. */
export interface HealthStatus extends JsonRecord {
  readonly status: HealthStatusValue
  readonly version: string
  readonly hasProviders: boolean
}
