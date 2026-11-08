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

export type IntelligenceSettingsPatch = Partial<IntelligenceSettings>

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
