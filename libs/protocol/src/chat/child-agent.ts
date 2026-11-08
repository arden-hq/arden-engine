import { Schema } from "effect"
import type { PersistedChildAgentMetadata } from "./contracts.js"
export type { AgentMode, PersistedChildAgentMetadata } from "./contracts.js"

export const AgentModeSchema = Schema.Literals(["research", "code", "work"] as const)

const IdentifierSchema = Schema.Trim.check(Schema.isMinLength(1))

export const PersistedChildAgentMetadataSchema: Schema.Codec<PersistedChildAgentMetadata> =
  Schema.Struct({
    session_id: IdentifierSchema,
    session_ref: IdentifierSchema,
    run_id: IdentifierSchema,
    status: Schema.Literal("running"),
    mode: AgentModeSchema
  })

/**
 * A child agent's own spend, which its spawning tool result may report beside
 * `child_agent`: tokens under `usage`, USD under `cost`. Neither enters the
 * parent's context; the parent run's totals already include the cost.
 */
export const ToolResultUsageSchema = Schema.Struct({
  prompt: Schema.Finite,
  completion: Schema.Finite,
  total: Schema.Finite,
  cache_read: Schema.optionalKey(Schema.Finite),
  cache_write: Schema.optionalKey(Schema.Finite)
})

export const ToolResultCostSchema = Schema.Finite
