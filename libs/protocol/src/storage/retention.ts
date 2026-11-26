import { Effect, Schema } from "effect"
import { makeEncoder, projectedDecoderFor } from "../common/boundary.js"

export const RETENTION = { forever: "forever", days: "days" } as const

export type RetentionPeriod =
  | { readonly kind: "forever" }
  | { readonly kind: "days"; readonly days: number }

export interface StorageRetention {
  readonly agentTrace: RetentionPeriod
  readonly wikiHistory: RetentionPeriod
}

export const DEFAULT_STORAGE_RETENTION: StorageRetention = Object.freeze({
  agentTrace: { kind: RETENTION.forever },
  wikiHistory: { kind: RETENTION.forever }
})

const Period = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(RETENTION.forever) }),
  Schema.Struct({
    kind: Schema.Literal(RETENTION.days),
    days: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(3650))
  })
])

export const StorageRetentionSchema = Schema.Struct({
  agent_trace: Period,
  wiki_history: Period
})

export const decodeStorageRetention = projectedDecoderFor(
  StorageRetentionSchema,
  (value): StorageRetention => ({
    agentTrace: value.agent_trace,
    wikiHistory: value.wiki_history
  }),
  "Invalid retention settings"
)

export const encodeStorageRetention = makeEncoder<StorageRetention>(
  (value: unknown) =>
    Schema.decodeUnknownEffect(Schema.Struct({ agentTrace: Period, wikiHistory: Period }))(
      value
    ).pipe(
      Effect.map((value) =>
        JSON.stringify({ agent_trace: value.agentTrace, wiki_history: value.wikiHistory })
      )
    ),
  "Invalid retention settings"
)
