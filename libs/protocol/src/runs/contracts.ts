export type { RunApproval } from "./approvals.js"
export type { HomePresenceInput, HomeLetterBody, HomeLetterResponse } from "./home.js"
import type { AppDestination } from "../common/navigation.js"
import type { ChatProjectionEvent } from "../chat/events/stream.js"
import type { JsonRecord, JsonValue } from "../common/json.js"
import type { RuntimeRunStatus } from "../chat/runtime.js"
import type { AutomationRunOutcome } from "../automations/outcome.js"
import type { ModelCallKind } from "./usage.js"
export type { HomeEvidence, HomeEvidenceQuery, HomeEvidencePage } from "./home.js"

export type { RunApprovalWork, RunOrigin, RunTaskBinding, RunContext } from "./context.js"
export type { WorkerAttempt, WorkerAttemptPage, WorkerAttemptPageOptions } from "./attempts.js"
export type {
  RunQuestion,
  RunQuestionContent,
  RunQuestionList,
  RunQuestionListOptions,
  ResolveRunQuestionInput
} from "./questions.js"

export interface RunUsage extends JsonRecord {
  readonly prompt: number
  readonly completion: number
  readonly total: number
  readonly cache_read: number
  readonly cache_write: number
}

/** Final model output and bounded execution metrics persisted with a completed Run. */
export interface RunTerminalResult extends JsonRecord {
  readonly text: string
  readonly data: JsonValue
  readonly usage: RunUsage
  readonly cost: number
  readonly duration_ms: number
  readonly tool_time_ms: number
  readonly steps: number
  readonly last_input_tokens: number | null
}

export interface RunError extends JsonRecord {
  readonly code: string
  readonly message: string
}

export interface RunLocalInstructionSource extends JsonRecord {
  readonly root: string
  readonly path: string
  readonly scope: string
  readonly status: "loaded" | "empty" | "unreadable" | "truncated"
  readonly digest: string | null
}

/** Durable, restart-safe projection of one Run. */
export interface RunDetail extends JsonRecord {
  readonly version: 1
  readonly run_id: string
  readonly session_id: string
  readonly turn_id: string
  readonly status: RuntimeRunStatus
  readonly started_at: string
  readonly updated_at: string
  readonly ended_at: string | null
  readonly stop_reason: string | null
  readonly last_event_sequence: number | null
  readonly model_id: string | null
  readonly reasoning_effort: string | null
  readonly client_id: string | null
  readonly result: RunTerminalResult | null
  readonly late_result_at: string | null
  readonly error: RunError | null
  readonly local_instructions?: ReadonlyArray<RunLocalInstructionSource>
}

export interface RunEvent extends JsonRecord {
  readonly sequence: number
  readonly created_at: string
  readonly event: ChatProjectionEvent
}

/** One ordered page from the Run's durable event journal. */
export interface RunEventPage extends JsonRecord {
  readonly run_id: string
  readonly session_id: string
  readonly trace_removed_at: string | null
  readonly events: ReadonlyArray<RunEvent>
  readonly next_after_sequence: number
  readonly has_more: boolean
}

export interface RunEventPageOptions {
  readonly afterSequence?: number
  readonly limit?: number
}

/** One day × attribution × kind cell of the durable usage rollup. */
export interface UsageDailyCell extends JsonRecord {
  /** UTC calendar date of the runs' start, YYYY-MM-DD. */
  readonly day: string
  readonly space_id: string | null
  readonly space_name: string | null
  /** "automation" when the run was scheduled work, on any space or none. */
  readonly origin: "user" | "automation"
  /** Null for a call that belongs to no chat (a Space overview). */
  readonly session_type: "chat" | "channel" | "agent" | null
  readonly model_id: string | null
  /** What the calls were for; `usageGroup` folds it into a product group. */
  readonly kind: ModelCallKind
  readonly total: number
  readonly output: number
  readonly cache_read: number
  readonly cache_write: number
  /** Runs for kind `chat`; model calls for every other kind. */
  readonly runs: number
}

export interface UsageTopSession extends JsonRecord {
  readonly session_id: string
  readonly name: string | null
  readonly space_id: string | null
  readonly space_name: string | null
  readonly session_type: "chat" | "channel" | "agent"
  readonly total: number
  readonly output: number
  readonly cache_read: number
  readonly cache_write: number
  readonly runs: number
  /** Mean final model-input size across the session's recorded Runs. */
  readonly average_last_input: number | null
}

export interface UsageAutomationRow extends JsonRecord {
  readonly task_id: string | null
  readonly item_id: string | null
  readonly space_id: string | null
  readonly name: string
  readonly destination: AppDestination | null
  readonly purpose: "user_automation" | "space_review" | "task_execution" | "system" | null
  readonly handler: string | null
  readonly checks: number
  /** Runs with recorded usage; unknown usage is counted separately. */
  readonly runs: number
  readonly unaccounted_runs: number
  readonly total: number
  readonly cache_read: number
  readonly outcomes: ReadonlyArray<UsageAutomationOutcome>
}

export interface UsageAutomationOutcome extends JsonRecord {
  /** Null means no outcome was recorded (a run still going), not no change. */
  readonly outcome: AutomationRunOutcome | null
  readonly checks: number
  readonly runs: number
  readonly unaccounted_runs: number
  readonly total: number
  readonly output: number
  readonly cache_read: number
  readonly cache_write: number
}

/** Token spend for one window: durable daily rollup plus live per-session lenses. */
export interface UsageReport extends JsonRecord {
  readonly days: number
  /** First UTC day inside the window, YYYY-MM-DD. */
  readonly since: string
  readonly daily: ReadonlyArray<UsageDailyCell>
  readonly top_sessions: ReadonlyArray<UsageTopSession>
  readonly automations: ReadonlyArray<UsageAutomationRow>
}

/** One metered window of a plan. */
export interface PlanWindow extends JsonRecord {
  /** 0–100, as the provider reports it. */
  readonly used_percent: number
  readonly window_seconds: number
  readonly resets_at: string
  readonly pace: PlanWindowPace
}

/** How the window is being spent against the limit Arden stops at. */
export interface PlanWindowPace extends JsonRecord {
  /** The limit the pace line ends at: the Arden limit, or 100 when there is none. */
  readonly limit_percent: number
  /** Share of the window that has passed, 0–100. */
  readonly elapsed_percent: number
  /** Where even use would put the window now. */
  readonly on_pace_percent: number
  readonly ahead: boolean
  /** When the limit is reached at the recent rate; null when not before the reset. */
  readonly reaches_limit_at: string | null
}

/** Provider-reported credits; availability is authoritative even without a balance. */
export type PlanCredits =
  | { readonly kind: "unlimited" }
  | { readonly kind: "limited"; readonly available: boolean; readonly balance: number | null }

/** The latest reading of a plan Arden runs on. */
export interface PlanLimits extends JsonRecord {
  readonly provider: string
  /** The plan's name as the provider reports it, e.g. "pro"; null until the provider says. */
  readonly plan: string | null
  /** Shortest window first. */
  readonly windows: ReadonlyArray<PlanWindow>
  readonly credits: PlanCredits | null
  readonly observed_at: string
}

/** Every plan with a meter; empty when signed out or the route has none. */
export interface PlanLimitsReport extends JsonRecord {
  readonly plans: ReadonlyArray<PlanLimits>
}

export interface UsageReportOptions {
  readonly days?: number
}

/** One model call of a Run; usage is null until (unless) its response arrived. */
export interface RunModelCall extends JsonRecord {
  readonly usage: RunUsage | null
  /** When the request was admitted; null on calls recorded before the stamp existed. */
  readonly admitted_at: string | null
  /** When the response was recorded; null until it arrived, and on older calls. */
  readonly responded_at: string | null
}

/** Execution metrics from a Run's terminal result. */
export interface RunTiming extends JsonRecord {
  readonly duration_ms: number
  readonly tool_time_ms: number
  readonly steps: number
}

/** One stored Run of a chat with its model calls in the order they were made. */
export interface SessionRunRecord extends JsonRecord {
  readonly run_id: string
  readonly turn_id: string
  /** The turn's place in the chat, once the turn is indexed. */
  readonly turn_index: number | null
  readonly status: RuntimeRunStatus
  readonly started_at: string
  readonly ended_at: string | null
  readonly model_id: string | null
  readonly reasoning_effort: string | null
  /** Null when the Run has no terminal result (running, failed, cancelled). */
  readonly timing: RunTiming | null
  readonly calls: ReadonlyArray<RunModelCall>
}

/** A chat's Run as the Developer panel reads it. */
export interface SessionRunUsage extends SessionRunRecord {
  /** The model's context window from the catalog; null when the catalog does not know the model. */
  readonly context_window: number | null
}

/** A chat's latest Runs, newest first, for the Developer panel. */
export interface SessionUsageReport extends JsonRecord {
  readonly session_id: string
  readonly runs: ReadonlyArray<SessionRunUsage>
}

export interface SessionUsageOptions {
  readonly limit?: number
}
