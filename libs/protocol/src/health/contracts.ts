import type { JsonRecord } from "../common/json.js"

export const HEALTH_STATUS_VALUE = { ok: "ok", unavailable: "unavailable" } as const

export type HealthStatusValue = (typeof HEALTH_STATUS_VALUE)[keyof typeof HEALTH_STATUS_VALUE]

export interface HealthStatus extends JsonRecord {
  readonly status: HealthStatusValue
  readonly version: string
  readonly hasProviders: boolean
}
