import type { JsonRecord } from "../common/json.js"

import type { WorkflowStatus } from "./status.js"

export type WorkflowEffectDisposition = "none" | "no_op" | "applied" | "unknown"

export type WorkflowErrorCode =
  | "coordinator_failed"
  | "agent_failed"
  | "schema_invalid"
  | "interrupted"
  | "cancelled"
  | "timed_out"
  | "budget_exhausted"
  | "conflict"
  | "uncertain_effect"
  | "storage"
  | "internal"

/** One source reference retained with an outcome. */
export interface WorkflowSourceRef extends JsonRecord {
  readonly provider: string
  readonly kind: string
  readonly ref: string
  readonly title: string
}

export interface WorkflowError extends JsonRecord {
  readonly code: WorkflowErrorCode
  readonly message: string
  readonly retryable: boolean
  readonly recovery_action: string | null
  /** One plain line for a person, when the message is written for the model. */
  readonly preview?: string
}

/** A script's own record: one row per detached code_mode script. */
export interface ScriptSummary extends JsonRecord {
  readonly workflow_ref: string
  readonly version: number
  readonly status: WorkflowStatus
  readonly attempt: number
  readonly origin_session_ref: string
  readonly origin_run_id: string
  readonly origin_tool_call_id: string
  readonly error: WorkflowError | null
  readonly created_at: string
  readonly updated_at: string
  readonly ended_at: string | null
}

/** An admitted child run; later steering in the same chat does not change this execution. */
export interface ScriptAgentAttempt extends JsonRecord {
  readonly session_ref: string
  readonly run_id: string | null
  readonly tool_call_id: string
  readonly status: string
}

/** One `agent()` of a script, as its latest child session stands. */
export interface ScriptAgent extends JsonRecord {
  readonly key: string
  readonly attempts: ReadonlyArray<ScriptAgentAttempt>
  readonly label: string
  readonly mode: "research" | "code" | null
  readonly status: "running" | "completed" | "failed"
  readonly session_ref: string
}

export interface ScriptDetail extends JsonRecord {
  readonly script: ScriptSummary
  readonly agents: ReadonlyArray<ScriptAgent>
  /** Last nonempty progress per attempt, from the durable tool journal. */
  readonly executions: ReadonlyArray<ScriptExecution>
}

export interface ScriptExecution extends JsonRecord {
  readonly attempt: number
  readonly data: JsonRecord
}

/** Caller context required by every script HTTP route. */
export interface WorkflowRouteTarget {
  readonly workflowRef: string
  readonly sessionId: string
}

export interface ScriptRetryRequest {
  /** The version the caller saw: a script that changed since is not retried. */
  readonly expected_version: number
}
