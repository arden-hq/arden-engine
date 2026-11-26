import { Effect, Schema, type SchemaAST } from "effect"
import { withExtras } from "../common/schema.js"
import {
  INTELLIGENCE_SETTINGS_CHANGE,
  type IntelligenceSettings,
  type IntelligenceSettingsPatch
} from "./contracts.js"

const strict: SchemaAST.ParseOptions = { onExcessProperty: "error" }
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

const valueChange = <K extends string, S extends Schema.Top>(kind: K, value: S) =>
  Schema.Struct({ kind: Schema.Literal(kind), value })

const IntelligenceSettingsChangeSchema = Schema.Union([
  valueChange(INTELLIGENCE_SETTINGS_CHANGE.assistantName, AssistantNameSchema),
  valueChange(INTELLIGENCE_SETTINGS_CHANGE.maxAgentDepth, MaxAgentDepthSchema),
  valueChange(INTELLIGENCE_SETTINGS_CHANGE.maxConcurrentAgents, MaxConcurrentAgentsSchema),
  valueChange(INTELLIGENCE_SETTINGS_CHANGE.maxConcurrentWorkers, MaxConcurrentWorkersSchema),
  valueChange(INTELLIGENCE_SETTINGS_CHANGE.compactionThreshold, CompactionThresholdSchema),
  valueChange(INTELLIGENCE_SETTINGS_CHANGE.compactionKeepRatio, CompactionKeepRatioSchema),
  valueChange(INTELLIGENCE_SETTINGS_CHANGE.summaryMaxTokens, SummaryMaxTokensSchema)
])

export const IntelligenceSettingsPatchRequestSchema = Schema.Struct({
  changes: Schema.NonEmptyArray(IntelligenceSettingsChangeSchema)
})

type IntelligenceSettingsWire = Schema.Schema.Type<typeof IntelligenceSettingsResponseSchema>
export const mapSettings = (settings: IntelligenceSettingsWire): IntelligenceSettings => ({
  assistantName: settings.assistant_name,
  maxAgentDepth: settings.max_agent_depth,
  maxConcurrentAgents: settings.max_concurrent_agents,
  maxConcurrentWorkers: settings.max_concurrent_workers,
  compactionThreshold: settings.compaction_threshold,
  compactionKeepRatio: settings.compaction_keep_ratio,
  summaryMaxTokens: settings.summary_max_tokens
})

export const decodeIntelligenceSettingsPatchRequestEffect = (
  value: unknown
): Effect.Effect<IntelligenceSettingsPatch, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(IntelligenceSettingsPatchRequestSchema)(value, strict).pipe(
    Effect.map((patch) => patch.changes)
  )

export const encodeIntelligenceSettingsPatchEffect = (
  value: IntelligenceSettingsPatch
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(IntelligenceSettingsPatchRequestSchema)(
    { changes: value },
    strict
  ).pipe(Effect.map(JSON.stringify))
