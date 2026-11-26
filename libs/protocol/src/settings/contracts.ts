import type { JsonRecord } from "../common/json.js"

/** Live agent and context controls shared by the server and Desktop. */
export interface IntelligenceSettings extends JsonRecord {
  /** What the assistant calls itself, everywhere it says so. */
  readonly assistantName: string
  readonly maxAgentDepth: number
  readonly maxConcurrentAgents: number
  /** Shared slots for Tasks, Space workers, and Automations. */
  readonly maxConcurrentWorkers: number
  readonly compactionThreshold: number
  readonly compactionKeepRatio: number
  readonly summaryMaxTokens: number
}

export const INTELLIGENCE_SETTINGS_CHANGE = {
  assistantName: "assistant_name",
  maxAgentDepth: "max_agent_depth",
  maxConcurrentAgents: "max_concurrent_agents",
  maxConcurrentWorkers: "max_concurrent_workers",
  compactionThreshold: "compaction_threshold",
  compactionKeepRatio: "compaction_keep_ratio",
  summaryMaxTokens: "summary_max_tokens"
} as const

export type IntelligenceSettingsChange =
  | { readonly kind: "assistant_name"; readonly value: string }
  | { readonly kind: "max_agent_depth"; readonly value: number }
  | { readonly kind: "max_concurrent_agents"; readonly value: number }
  | { readonly kind: "max_concurrent_workers"; readonly value: number }
  | { readonly kind: "compaction_threshold"; readonly value: number }
  | { readonly kind: "compaction_keep_ratio"; readonly value: number }
  | { readonly kind: "summary_max_tokens"; readonly value: number }

export type IntelligenceSettingsPatch = ReadonlyArray<IntelligenceSettingsChange>

const applyIntelligenceChange = (
  settings: IntelligenceSettings,
  change: IntelligenceSettingsChange
): IntelligenceSettings => {
  switch (change.kind) {
    case INTELLIGENCE_SETTINGS_CHANGE.assistantName:
      return { ...settings, assistantName: change.value }
    case INTELLIGENCE_SETTINGS_CHANGE.maxAgentDepth:
      return { ...settings, maxAgentDepth: change.value }
    case INTELLIGENCE_SETTINGS_CHANGE.maxConcurrentAgents:
      return { ...settings, maxConcurrentAgents: change.value }
    case INTELLIGENCE_SETTINGS_CHANGE.maxConcurrentWorkers:
      return { ...settings, maxConcurrentWorkers: change.value }
    case INTELLIGENCE_SETTINGS_CHANGE.compactionThreshold:
      return { ...settings, compactionThreshold: change.value }
    case INTELLIGENCE_SETTINGS_CHANGE.compactionKeepRatio:
      return { ...settings, compactionKeepRatio: change.value }
    case INTELLIGENCE_SETTINGS_CHANGE.summaryMaxTokens:
      return { ...settings, summaryMaxTokens: change.value }
  }
}

export const applyIntelligenceSettingsPatch = (
  settings: IntelligenceSettings,
  patch: IntelligenceSettingsPatch
): IntelligenceSettings => patch.reduce(applyIntelligenceChange, settings)

/** The factory values. The server seeds a fresh install from these and the
 *  Desktop's "Restore defaults" writes them back, so both read one source. */
export const DEFAULT_INTELLIGENCE_SETTINGS: IntelligenceSettings = Object.freeze({
  assistantName: "Arden",
  maxAgentDepth: 3,
  maxConcurrentAgents: 4,
  maxConcurrentWorkers: 4,
  compactionThreshold: 0.8,
  compactionKeepRatio: 0.2,
  summaryMaxTokens: 1_500
})
