import type { JsonRecord } from "./json.js"

export const PROVIDER_COST = { unreported: "unreported", reported: "reported" } as const

export type ProviderCost =
  | { readonly kind: typeof PROVIDER_COST.unreported }
  | { readonly kind: typeof PROVIDER_COST.reported; readonly usd: number }

export interface EventUsage extends JsonRecord {
  readonly prompt: number
  readonly completion: number
  readonly total: number
  readonly cache_read: number
  readonly cache_write: number
  readonly cost: ProviderCost
}

export interface EventFrame {
  readonly seq: number
  readonly timestamp: number
  readonly replay: boolean
}

export interface ChatEventFrame extends EventFrame {
  readonly session_id: string
}

export type Framed<Body, Frame extends EventFrame> = Body extends unknown ? Body & Frame : never
