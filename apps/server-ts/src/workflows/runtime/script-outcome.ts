import { Schema } from "effect"

import type { ScriptAgentChildAttemptEvent, ScriptAgentMode } from "./contract.js"
import type { ScriptProgressStatus, ScriptProgressTool } from "./nested-trace.js"

export const SCRIPT_ENVELOPE_STATUS = {
  succeeded: "succeeded",
  failed: "failed"
} as const

const ScriptEnvelopeSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal(SCRIPT_ENVELOPE_STATUS.succeeded),
    value: Schema.Json,
    logs: Schema.Array(Schema.String),
    phases: Schema.Array(Schema.String)
  }),
  Schema.Struct({
    status: Schema.Literal(SCRIPT_ENVELOPE_STATUS.failed),
    error: Schema.Struct({
      code: Schema.Literals([
        "coordinator_failed",
        "agent_failed",
        "cancelled",
        "timed_out",
        "budget_exhausted",
        "internal"
      ] as const),
      message: Schema.String,
      retryable: Schema.Boolean,
      preview: Schema.optionalKey(Schema.String),
      line: Schema.optionalKey(Schema.Number)
    }),
    logs: Schema.Array(Schema.String),
    phases: Schema.Array(Schema.String)
  })
]).pipe(Schema.toTaggedUnion("status"))
export const isScriptEnvelope = Schema.is(ScriptEnvelopeSchema)

export interface ScriptProgressAgent {
  readonly reused_tool_call_id: string | null
  readonly key: string
  readonly phase_id: string | null
  readonly child_attempts: ReadonlyArray<ScriptAgentChildAttemptEvent>
  readonly index: number
  readonly label: string
  readonly phase: string
  readonly mode: ScriptAgentMode
  readonly status: ScriptProgressStatus
}

export interface ScriptProgress {
  readonly phase_entries?: ReadonlyArray<{ readonly id: string; readonly title: string }>
  readonly phases: ReadonlyArray<string>
  readonly agents: ReadonlyArray<ScriptProgressAgent>
  readonly tools: ReadonlyArray<ScriptProgressTool>
}

export const SCRIPT_OUTCOME_STATUS = { completed: "completed", failed: "failed" } as const

export type ScriptOutcome =
  | {
      readonly status: typeof SCRIPT_OUTCOME_STATUS.completed
      readonly phase_entries: NonNullable<ScriptProgress["phase_entries"]>
      readonly value: Schema.Json
      readonly calls: ReadonlyArray<string>
      readonly tools: ReadonlyArray<ScriptProgressTool>
      readonly logs: ReadonlyArray<string>
      readonly phases: ReadonlyArray<string>
    }
  | {
      readonly status: typeof SCRIPT_OUTCOME_STATUS.failed
      readonly error: ScriptError
      readonly calls: ReadonlyArray<string>
      readonly logs: ReadonlyArray<string>
      readonly phases: ReadonlyArray<string>
      readonly agents: ReadonlyArray<ScriptProgressAgent>
    }

export interface ScriptError {
  readonly code:
    | "coordinator_failed"
    | "agent_failed"
    | "cancelled"
    | "timed_out"
    | "budget_exhausted"
    | "internal"
  readonly message: string
  readonly retryable: boolean
  readonly preview?: string
}
