import { contextSize } from "@arden-hq/protocol/chat"
import {
  PROVIDER_COST,
  type ProviderCost,
  type RunTerminalResult,
  type RunUsage
} from "@arden-hq/protocol/runs"
import { Schema } from "effect"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Dollars = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))

export const StoredRunUsageSchema = Schema.StructWithRest(
  Schema.Struct({
    prompt: Count,
    completion: Count,
    total: Count,
    cache_read: Count,
    cache_write: Count,
    cost: Schema.optionalKey(Dollars)
  }),
  [Schema.Record(Schema.String, Schema.Json)]
)

export type StoredRunUsage = typeof StoredRunUsageSchema.Type

export const StoredRunTerminalResultSchema = Schema.StructWithRest(
  Schema.Struct({
    text: Schema.String,
    data: Schema.Json,
    usage: StoredRunUsageSchema,
    cost: Schema.optionalKey(Dollars),
    duration_ms: Count,
    tool_time_ms: Count,
    steps: Count,
    last_input_tokens: Schema.NullOr(Count)
  }),
  [Schema.Record(Schema.String, Schema.Json)]
)

export type StoredRunTerminalResult = typeof StoredRunTerminalResultSchema.Type

export const providerCost = (usd: number | undefined): ProviderCost =>
  usd === undefined ? { kind: PROVIDER_COST.unreported } : { kind: PROVIDER_COST.reported, usd }

export const wireRunUsage = (usage: StoredRunUsage): RunUsage => ({
  prompt: usage.prompt,
  completion: usage.completion,
  total: usage.total,
  cache_read: usage.cache_read,
  cache_write: usage.cache_write,
  cost: providerCost(usage.cost)
})

export const wireRunTerminalResult = (result: StoredRunTerminalResult): RunTerminalResult => ({
  text: result.text,
  data: result.data,
  usage: wireRunUsage(result.usage),
  duration_ms: result.duration_ms,
  tool_time_ms: result.tool_time_ms,
  steps: result.steps,
  context: contextSize(result.last_input_tokens)
})
