import { Effect, Schema } from "effect"
import { withExtras } from "../common/schema.js"
import type { IntelligenceSettings, IntelligenceSettingsPatch } from "./contracts.js"

const strict = { onExcessProperty: "error" } as const
/** Counts the chat itself: 1 = no sub-agents, 2 = one level, 3 = two. */
const MaxAgentDepthSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(3)
)
const MaxConcurrentAgentsSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(10)
)
const MaxConcurrentWorkersSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(32)
)
const CompactionThresholdSchema = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(0.1),
  Schema.isLessThanOrEqualTo(1)
)
const CompactionKeepRatioSchema = Schema.Number.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(1)
)
const SummaryMaxTokensSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(256),
  Schema.isLessThanOrEqualTo(8_000)
)

/** What the assistant calls itself. */
const AssistantNameSchema = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(40),
  Schema.makeFilter((name) => (/[\r\n]/u.test(name) ? "must be a single line" : undefined))
)

export const IntelligenceSettingsSchema = Schema.Struct({
  assistantName: AssistantNameSchema,
  maxAgentDepth: MaxAgentDepthSchema,
  maxConcurrentAgents: MaxConcurrentAgentsSchema,
  maxConcurrentWorkers: MaxConcurrentWorkersSchema,
  compactionThreshold: CompactionThresholdSchema,
  compactionKeepRatio: CompactionKeepRatioSchema,
  summaryMaxTokens: SummaryMaxTokensSchema
})

export const IntelligenceSettingsResponseSchema = withExtras({
  assistant_name: AssistantNameSchema,
  max_agent_depth: MaxAgentDepthSchema,
  max_concurrent_agents: MaxConcurrentAgentsSchema,
  max_concurrent_workers: MaxConcurrentWorkersSchema,
  compaction_threshold: CompactionThresholdSchema,
  compaction_keep_ratio: CompactionKeepRatioSchema,
  summary_max_tokens: SummaryMaxTokensSchema
})

export const IntelligenceSettingsPatchSchema = Schema.Struct({
  assistantName: Schema.optionalKey(AssistantNameSchema),
  maxAgentDepth: Schema.optionalKey(MaxAgentDepthSchema),
  maxConcurrentAgents: Schema.optionalKey(MaxConcurrentAgentsSchema),
  maxConcurrentWorkers: Schema.optionalKey(MaxConcurrentWorkersSchema),
  compactionThreshold: Schema.optionalKey(CompactionThresholdSchema),
  compactionKeepRatio: Schema.optionalKey(CompactionKeepRatioSchema),
  summaryMaxTokens: Schema.optionalKey(SummaryMaxTokensSchema)
}).check(
  Schema.makeFilter((patch) =>
    Object.keys(patch).length > 0
      ? undefined
      : "an intelligence settings patch requires at least one field"
  )
)

export const IntelligenceSettingsPatchRequestSchema = Schema.Struct({
  assistant_name: Schema.optionalKey(AssistantNameSchema),
  max_agent_depth: Schema.optionalKey(MaxAgentDepthSchema),
  max_concurrent_agents: Schema.optionalKey(MaxConcurrentAgentsSchema),
  max_concurrent_workers: Schema.optionalKey(MaxConcurrentWorkersSchema),
  compaction_threshold: Schema.optionalKey(CompactionThresholdSchema),
  compaction_keep_ratio: Schema.optionalKey(CompactionKeepRatioSchema),
  summary_max_tokens: Schema.optionalKey(SummaryMaxTokensSchema)
}).check(
  Schema.makeFilter((patch) =>
    Object.keys(patch).length > 0
      ? undefined
      : "an intelligence settings patch requires at least one field"
  )
)

type IntelligenceSettingsWire = Schema.Schema.Type<typeof IntelligenceSettingsResponseSchema>
type IntelligenceSettingsPatchWire = Schema.Schema.Type<typeof IntelligenceSettingsPatchSchema>
type IntelligenceSettingsPatchRequestWire = Schema.Schema.Type<
  typeof IntelligenceSettingsPatchRequestSchema
>

export const mapSettings = (settings: IntelligenceSettingsWire): IntelligenceSettings => ({
  assistantName: settings.assistant_name,
  maxAgentDepth: settings.max_agent_depth,
  maxConcurrentAgents: settings.max_concurrent_agents,
  maxConcurrentWorkers: settings.max_concurrent_workers,
  compactionThreshold: settings.compaction_threshold,
  compactionKeepRatio: settings.compaction_keep_ratio,
  summaryMaxTokens: settings.summary_max_tokens
})

const mapPatchRequest = (
  patch: IntelligenceSettingsPatchRequestWire
): IntelligenceSettingsPatch => ({
  ...(patch.assistant_name === undefined ? {} : { assistantName: patch.assistant_name }),
  ...(patch.max_agent_depth === undefined ? {} : { maxAgentDepth: patch.max_agent_depth }),
  ...(patch.max_concurrent_agents === undefined
    ? {}
    : { maxConcurrentAgents: patch.max_concurrent_agents }),
  ...(patch.max_concurrent_workers === undefined
    ? {}
    : { maxConcurrentWorkers: patch.max_concurrent_workers }),
  ...(patch.compaction_threshold === undefined
    ? {}
    : { compactionThreshold: patch.compaction_threshold }),
  ...(patch.compaction_keep_ratio === undefined
    ? {}
    : { compactionKeepRatio: patch.compaction_keep_ratio }),
  ...(patch.summary_max_tokens === undefined ? {} : { summaryMaxTokens: patch.summary_max_tokens })
})

const encodePatch = (patch: IntelligenceSettingsPatchWire): Record<string, unknown> => ({
  ...(patch.assistantName === undefined ? {} : { assistant_name: patch.assistantName }),
  ...(patch.maxAgentDepth === undefined ? {} : { max_agent_depth: patch.maxAgentDepth }),
  ...(patch.maxConcurrentAgents === undefined
    ? {}
    : { max_concurrent_agents: patch.maxConcurrentAgents }),
  ...(patch.maxConcurrentWorkers === undefined
    ? {}
    : { max_concurrent_workers: patch.maxConcurrentWorkers }),
  ...(patch.compactionThreshold === undefined
    ? {}
    : { compaction_threshold: patch.compactionThreshold }),
  ...(patch.compactionKeepRatio === undefined
    ? {}
    : { compaction_keep_ratio: patch.compactionKeepRatio }),
  ...(patch.summaryMaxTokens === undefined ? {} : { summary_max_tokens: patch.summaryMaxTokens })
})

export const decodeIntelligenceSettingsPatchRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(IntelligenceSettingsPatchRequestSchema)(value, strict).pipe(
    Effect.map(mapPatchRequest)
  )

export const encodeIntelligenceSettingsPatchEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(IntelligenceSettingsPatchSchema)(value, strict).pipe(
    Effect.map(encodePatch),
    Effect.map(JSON.stringify)
  )
