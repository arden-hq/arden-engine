import { Schema } from "effect"
import { AGENT_MODE, type PersistedChildAgentMetadata } from "./contracts.js"
export type { AgentMode, PersistedChildAgentMetadata } from "./contracts.js"

export const AgentModeSchema = Schema.Literals(Object.values(AGENT_MODE))

const IdentifierSchema = Schema.Trim.check(Schema.isMinLength(1))

export const PersistedChildAgentMetadataSchema: Schema.Codec<PersistedChildAgentMetadata> =
  Schema.Struct({
    session_id: IdentifierSchema,
    session_ref: IdentifierSchema,
    run_id: IdentifierSchema,
    status: Schema.Literal("running"),
    mode: AgentModeSchema
  })
