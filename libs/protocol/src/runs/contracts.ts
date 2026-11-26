export type { RunApproval, RunApprovalConnection, RunApprovalText } from "./approvals.js"
export { APPROVAL_CONNECTION, APPROVAL_TEXT } from "./approvals.js"
export type { HomePresenceInput } from "./home.js"
import type { ChatProjectionEvent } from "../chat/events/stream.js"
import type { EventUsage } from "../common/event-fields.js"
import type { JsonRecord, JsonValue } from "../common/json.js"
import type {
  LOCAL_INSTRUCTION_STATUS,
  RUN_STOP_REASON,
  RUN_RESULT,
  RUN_FAILURE,
  RUN_EVENTS_SEEN,
  RUN_MODEL,
  RUN_REASONING,
  RUN_CLIENT,
  RUN_TRACE,
  PLAN_LIMIT_REACHED,
  PLAN_CREDITS,
  CREDIT_BALANCE,
  PLAN_NAME
} from "./run-states.js"
export {
  PROVIDER_COST,
  LOCAL_INSTRUCTION_STATUS,
  RUN_STOP_REASON,
  RUN_RESULT,
  RUN_FAILURE,
  RUN_EVENTS_SEEN,
  RUN_MODEL,
  RUN_REASONING,
  RUN_CLIENT,
  RUN_TRACE,
  PLAN_LIMIT_REACHED,
  PLAN_CREDITS,
  CREDIT_BALANCE,
  PLAN_NAME
} from "./run-states.js"
import type { ContextSize } from "../chat/events/run.js"
import type { RunMemoryContext } from "./memory.js"
export {
  MEMORY_BUDGET_STATE,
  MEMORY_OUTCOME,
  MEMORY_RECALL,
  MEMORY_REVISION,
  MEMORY_SPACE_PAGE
} from "./memory.js"
export type {
  RunMemoryAllowances,
  RunMemoryBudget,
  RunMemoryComposition,
  RunMemoryContext,
  RunMemoryCoreSource,
  RunMemoryCutReason,
  RunMemoryIndexSource,
  RunMemoryOutcome,
  RunMemoryPlacement,
  RunMemoryReader,
  RunMemoryRecall,
  RunMemoryRecallRole,
  RunMemoryRecalledSource,
  RunMemoryRevision,
  RunMemorySource,
  RunMemorySpacePage,
  RunMemorySpaceSource
} from "./memory.js"
import type { ActiveRunStatus, TerminalRunStatus } from "./status.js"
export {
  CALL_METER,
  CONTEXT_WINDOW,
  RUN_TIMING,
  STAMP,
  TURN_PLACE,
  USAGE_CHAT,
  USAGE_LINK,
  USAGE_SPACE
} from "./usage-report.js"
export type {
  RunCallMeter,
  RunContextWindow,
  RunModelCall,
  RunStamp,
  RunTiming,
  RunTurnPlace,
  SessionRunUsage,
  SessionUsageReport,
  UsageAutomation,
  UsageAutomationOutcome,
  UsageAutomationRow,
  UsageChat,
  UsageDailyCell,
  UsageDestination,
  UsageHandler,
  UsageOutcome,
  UsagePurpose,
  UsageReport,
  UsageRowSpace,
  UsageSessionType,
  UsageSpace,
  UsageTask,
  UsageTopSession
} from "./usage-report.js"

export type { RunApprovalWork, RunOrigin, RunTaskBinding, RunContext } from "./context.js"
export { RUN_BELONGS_TO, RUN_ORIGIN, RUN_TASK_BINDING } from "./context.js"
export type { WorkerAttempt, WorkerAttemptPage } from "./attempts.js"
export { ATTEMPT_END, ATTEMPT_RUN, ATTEMPT_TEXT } from "./attempts.js"
export type {
  RunQuestion,
  AnswerSaid,
  RunQuestionAnswerValue,
  RunQuestionContent,
  RunQuestionList,
  QuestionText,
  ResolveRunQuestionInput
} from "./questions.js"
export {
  RUN_LIST_FILTER,
  RUN_LIST_PAGE_MAX,
  RUN_PAGE,
  RUN_PAGE_NEXT,
  RUN_QUESTION_FILTER,
  RUN_QUESTION_STATE,
  WORKER_ATTEMPT_PAGE_MAX
} from "./list-options.js"
export type {
  RunEventPageOptions,
  RunListFilter,
  RunListOptions,
  RunPage,
  RunPageNext,
  RunQuestionFilter,
  RunQuestionListOptions,
  RunQuestionState,
  SessionUsageOptions,
  UsageReportOptions,
  WorkerAttemptPageOptions
} from "./list-options.js"

export type { ProviderCost } from "../common/event-fields.js"

export type RunUsage = EventUsage

export interface RunTerminalResult extends JsonRecord {
  readonly text: string
  readonly data: JsonValue
  readonly usage: RunUsage
  readonly duration_ms: number
  readonly tool_time_ms: number
  readonly steps: number
  readonly context: ContextSize
}

export interface RunError extends JsonRecord {
  readonly code: string
  readonly message: string
}

interface RunLocalInstructionPlace extends JsonRecord {
  readonly root: string
  readonly path: string
  readonly scope: string
}

export type RunLocalInstructionSource =
  | (RunLocalInstructionPlace & {
      readonly status:
        | typeof LOCAL_INSTRUCTION_STATUS.loaded
        | typeof LOCAL_INSTRUCTION_STATUS.truncated
      readonly digest: string
    })
  | (RunLocalInstructionPlace & {
      readonly status:
        | typeof LOCAL_INSTRUCTION_STATUS.empty
        | typeof LOCAL_INSTRUCTION_STATUS.unreadable
    })

export type RunStopReason =
  | { readonly kind: typeof RUN_STOP_REASON.unstated }
  | { readonly kind: typeof RUN_STOP_REASON.stated; readonly reason: string }

export type RunResultState =
  | { readonly kind: typeof RUN_RESULT.none }
  | { readonly kind: typeof RUN_RESULT.on_time; readonly result: RunTerminalResult }
  | {
      readonly kind: typeof RUN_RESULT.late
      readonly result: RunTerminalResult
      readonly at: string
    }

export type RunFailure =
  | { readonly kind: typeof RUN_FAILURE.none }
  | ({ readonly kind: typeof RUN_FAILURE.failed } & RunError)

export type RunEventsSeen =
  | { readonly kind: typeof RUN_EVENTS_SEEN.none }
  | { readonly kind: typeof RUN_EVENTS_SEEN.through; readonly sequence: number }

export type RunModel =
  | { readonly kind: typeof RUN_MODEL.unrecorded }
  | { readonly kind: typeof RUN_MODEL.model; readonly model_id: string }

export type RunReasoning =
  | { readonly kind: typeof RUN_REASONING.default }
  | { readonly kind: typeof RUN_REASONING.effort; readonly effort: string }

export type RunClient =
  | { readonly kind: typeof RUN_CLIENT.none }
  | { readonly kind: typeof RUN_CLIENT.client; readonly client_id: string }

interface RunDetailFields extends JsonRecord {
  readonly version: 1
  readonly run_id: string
  readonly session_id: string
  readonly turn_id: string
  readonly started_at: string
  readonly updated_at: string
  readonly events: RunEventsSeen
  readonly model: RunModel
  readonly reasoning: RunReasoning
  readonly client: RunClient
  readonly local_instructions: ReadonlyArray<RunLocalInstructionSource>
  readonly memory_context: ReadonlyArray<RunMemoryContext>
}

export interface ActiveRunDetail extends RunDetailFields {
  readonly status: ActiveRunStatus
}

export interface EndedRunDetail extends RunDetailFields {
  readonly status: TerminalRunStatus
  readonly ended_at: string
  readonly stop_reason: RunStopReason
  readonly result: RunResultState
  readonly failure: RunFailure
}

export type RunDetail = ActiveRunDetail | EndedRunDetail

export interface RunEvent extends JsonRecord {
  readonly sequence: number
  readonly created_at: string
  readonly event: ChatProjectionEvent
}

export type RunTrace =
  | { readonly kind: typeof RUN_TRACE.kept }
  | { readonly kind: typeof RUN_TRACE.removed; readonly at: string }

export interface RunEventPage extends JsonRecord {
  readonly run_id: string
  readonly session_id: string
  readonly trace: RunTrace
  readonly events: ReadonlyArray<RunEvent>
  readonly next_after_sequence: number
  readonly has_more: boolean
}

export type PlanLimitReached =
  | { readonly kind: typeof PLAN_LIMIT_REACHED.not_before_reset }
  | { readonly kind: typeof PLAN_LIMIT_REACHED.at; readonly at: string }

export interface PlanWindowPace extends JsonRecord {
  readonly limit_percent: number
  readonly elapsed_percent: number
  readonly on_pace_percent: number
  readonly ahead: boolean
  readonly reaches_limit: PlanLimitReached
}

export interface PlanWindow extends JsonRecord {
  readonly used_percent: number
  readonly window_seconds: number
  readonly resets_at: string
  readonly pace: PlanWindowPace
}

export type PlanCreditBalance =
  | { readonly kind: typeof CREDIT_BALANCE.unreported }
  | { readonly kind: typeof CREDIT_BALANCE.reported; readonly amount: number }

export type PlanCredits =
  | { readonly kind: typeof PLAN_CREDITS.unreported }
  | { readonly kind: typeof PLAN_CREDITS.unlimited }
  | {
      readonly kind: typeof PLAN_CREDITS.limited
      readonly available: boolean
      readonly balance: PlanCreditBalance
    }

export type PlanName =
  | { readonly kind: typeof PLAN_NAME.unnamed }
  | { readonly kind: typeof PLAN_NAME.named; readonly name: string }

export interface PlanLimits extends JsonRecord {
  readonly provider: string
  readonly plan: PlanName
  readonly windows: ReadonlyArray<PlanWindow>
  readonly credits: PlanCredits
  readonly observed_at: string
}

export interface PlanLimitsReport extends JsonRecord {
  readonly plans: ReadonlyArray<PlanLimits>
}
