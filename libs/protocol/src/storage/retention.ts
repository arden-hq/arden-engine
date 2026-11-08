import { Effect, Schema } from "effect"
import { makeEncoder, projectedDecoderFor } from "../common/boundary.js"

export interface StorageRetention {
  readonly agentTraceDays: number | null
  readonly wikiHistoryDays: number | null
}

/** Nothing is trimmed until you turn it on. */
export const DEFAULT_STORAGE_RETENTION: StorageRetention = Object.freeze({
  agentTraceDays: null,
  wikiHistoryDays: null
})

const Days = Schema.NullOr(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(3650))
)

export const StorageRetentionSchema = Schema.Struct({
  agent_trace_days: Days,
  wiki_history_days: Days
})

export const decodeStorageRetention = projectedDecoderFor(
  StorageRetentionSchema,
  (value): StorageRetention => ({
    agentTraceDays: value.agent_trace_days,
    wikiHistoryDays: value.wiki_history_days
  }),
  "Invalid retention settings"
)

export const encodeStorageRetention = makeEncoder<StorageRetention>(
  (value: unknown) =>
    Schema.decodeUnknownEffect(Schema.Struct({ agentTraceDays: Days, wikiHistoryDays: Days }))(
      value
    ).pipe(
      Effect.map((value) =>
        JSON.stringify({
          agent_trace_days: value.agentTraceDays,
          wiki_history_days: value.wikiHistoryDays
        })
      )
    ),
  "Invalid retention settings"
)
