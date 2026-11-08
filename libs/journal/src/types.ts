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
  /** Durable by default. Live-only records cannot be replayed. */
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

export type JournalDelivery =
  | {
      readonly kind: "record"
      readonly record: JournalRecord
      /** True only for the initial historical replay. */
      readonly replayed: boolean
    }
  | {
      readonly kind: "reset"
      readonly reason: "future_cursor" | "replay_gap"
      readonly cursor: number
    }
  | {
      /** The bounded live follower could not retain every unseen signal. */
      readonly kind: "overflow"
      readonly cursor: number
    }
