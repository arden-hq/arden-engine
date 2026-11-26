export type JsonPrimitive = string | number | boolean | null
export type JsonValue =
  | JsonPrimitive
  | ReadonlyArray<JsonValue>
  | {
      readonly [key: string]: JsonValue
    }

export interface JournalEvent {
  readonly type: string
  readonly data: JsonValue
  readonly attributes?: Readonly<Record<string, JsonValue>>
  readonly durable?: boolean
}

export interface JournalRecord {
  readonly streamId: string
  readonly sequence: number
  readonly type: string
  readonly data: JsonValue
  readonly attributes: Readonly<Record<string, JsonValue>>
  readonly durable: boolean
  readonly createdAt: string
}

export interface JournalAppendResult {
  readonly records: ReadonlyArray<JournalRecord>
  readonly headSequence: number
}

export const JOURNAL_DELIVERY = { record: "record", reset: "reset", overflow: "overflow" } as const

export type JournalDelivery =
  | {
      readonly kind: typeof JOURNAL_DELIVERY.record
      readonly record: JournalRecord
      readonly replayed: boolean
    }
  | {
      readonly kind: typeof JOURNAL_DELIVERY.reset
      readonly reason: "future_cursor" | "replay_gap"
      readonly cursor: number
    }
  | {
      readonly kind: typeof JOURNAL_DELIVERY.overflow
      readonly cursor: number
    }
