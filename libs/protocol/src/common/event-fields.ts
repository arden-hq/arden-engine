import type { JsonRecord } from "./json.js"

export interface EventUsage extends JsonRecord {
  readonly prompt?: number
  readonly completion?: number
  readonly total?: number
  readonly cache_read?: number
  readonly cache_write?: number
  readonly cost?: number
  readonly exclusive_cost?: number
}

export interface CommonServerEventFields extends JsonRecord {
  readonly timestamp?: number
  readonly seq?: number
  readonly session_id?: string
  readonly replay?: boolean
}
