import type { JsonRecord } from "../common/json.js"
import type { RuntimeRunStatus } from "../chat/runtime.js"

import type { WorkflowStatus } from "./status.js"

export const WORKFLOW_EFFECT = {
  none: "none",
  no_op: "no_op",
  applied: "applied",
  unknown: "unknown"
} as const

export type WorkflowEffectDisposition = (typeof WORKFLOW_EFFECT)[keyof typeof WORKFLOW_EFFECT]

export const WORKFLOW_ERROR_CODE = {
  coordinator_failed: "coordinator_failed",
  agent_failed: "agent_failed",
  schema_invalid: "schema_invalid",
  interrupted: "interrupted",
  cancelled: "cancelled",
  timed_out: "timed_out",
  budget_exhausted: "budget_exhausted",
  conflict: "conflict",
  uncertain_effect: "uncertain_effect",
  storage: "storage",
  internal: "internal"
} as const

export type WorkflowErrorCode = (typeof WORKFLOW_ERROR_CODE)[keyof typeof WORKFLOW_ERROR_CODE]

export interface WorkflowSourceRef extends JsonRecord {
  readonly provider: string
  readonly kind: string
  readonly ref: string
  readonly title: string
}

export const WORKFLOW_RECOVERY = { none: "none", action: "action" } as const
export const WORKFLOW_PREVIEW = { message: "message", line: "line" } as const
export const SCRIPT_END = { open: "open", ended: "ended" } as const
export const SCRIPT_FAILURE = { none: "none", failed: "failed" } as const
export const AGENT_RUN = { none: "none", run: "run" } as const

export type WorkflowRecovery =
  | { readonly kind: "none" }
  | { readonly kind: "action"; readonly text: string }

export type WorkflowPreview =
  | { readonly kind: "message" }
  | { readonly kind: "line"; readonly text: string }

export const NO_RECOVERY: WorkflowRecovery = { kind: WORKFLOW_RECOVERY.none }
export const MESSAGE_PREVIEW: WorkflowPreview = { kind: WORKFLOW_PREVIEW.message }
export const recoverBy = (text: string): WorkflowRecovery => ({
  kind: WORKFLOW_RECOVERY.action,
  text
})

export interface WorkflowError extends JsonRecord {
  readonly code: WorkflowErrorCode
  readonly message: string
  readonly retryable: boolean
  readonly recovery: WorkflowRecovery
  readonly preview: WorkflowPreview
}

export type ScriptEnd = { readonly kind: "open" } | { readonly kind: "ended"; readonly at: string }

export type ScriptFailure =
  | { readonly kind: "none" }
  | { readonly kind: "failed"; readonly error: WorkflowError }

export interface ScriptSummary extends JsonRecord {
  readonly workflow_ref: string
  readonly version: number
  readonly status: WorkflowStatus
  readonly attempt: number
  readonly origin_session_ref: string
  readonly origin_run_id: string
  readonly origin_tool_call_id: string
  readonly failure: ScriptFailure
  readonly created_at: string
  readonly updated_at: string
  readonly end: ScriptEnd
}

export interface ScriptAgentAttempt extends JsonRecord {
  readonly session_ref: string
  readonly tool_call_id: string
  readonly run:
    | { readonly kind: typeof AGENT_RUN.none }
    | {
        readonly kind: typeof AGENT_RUN.run
        readonly run_id: string
        readonly status: RuntimeRunStatus
      }
}

export interface ScriptAgent extends JsonRecord {
  readonly key: string
  readonly attempts: ReadonlyArray<ScriptAgentAttempt>
  readonly label: string
  readonly mode: "research" | "code" | "work" | "unrecorded"
  readonly status: "running" | "completed" | "failed"
  readonly session_ref: string
}

export interface ScriptDetail extends JsonRecord {
  readonly script: ScriptSummary
  readonly agents: ReadonlyArray<ScriptAgent>
  readonly executions: ReadonlyArray<ScriptExecution>
}

export interface ScriptExecution extends JsonRecord {
  readonly attempt: number
  readonly data: JsonRecord
}

export interface WorkflowRouteTarget {
  readonly workflowRef: string
  readonly sessionId: string
}

export interface ScriptRetryRequest {
  readonly expected_version: number
}
