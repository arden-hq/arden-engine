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
