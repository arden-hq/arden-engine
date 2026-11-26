export type { RunApproval } from "./approvals.js"
export type { HomePresenceInput, HomeLetterBody, HomeLetterResponse } from "./home.js"
import type { AppDestination } from "../common/navigation.js"
import type { ChatProjectionEvent } from "../chat/events/stream.js"
import type { JsonRecord, JsonValue } from "../common/json.js"
import type { RuntimeRunStatus } from "../chat/runtime.js"
import type { AutomationRunOutcome } from "../automations/outcome.js"
import type { ModelCallKind } from "./usage.js"
import type { ContextSize } from "../chat/events/run.js"
import type { ActiveRunStatus, TerminalRunStatus } from "./status.js"
export type { HomeEvidence } from "./home.js"

export type { RunApprovalWork, RunOrigin, RunTaskBinding, RunContext } from "./context.js"
export type { WorkerAttempt, WorkerAttemptPage } from "./attempts.js"
export type {
  RunQuestion,
  RunQuestionContent,
  RunQuestionList,
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

export const PROVIDER_COST = { unreported: "unreported", reported: "reported" } as const

export type ProviderCost =
  | { readonly kind: typeof PROVIDER_COST.unreported }
  | { readonly kind: typeof PROVIDER_COST.reported; readonly usd: number }

export interface RunUsage extends JsonRecord {
  readonly prompt: number
  readonly completion: number
  readonly total: number
  readonly cache_read: number
  readonly cache_write: number
  readonly cost: ProviderCost
}

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

export const LOCAL_INSTRUCTION_STATUS = {
  loaded: "loaded",
  truncated: "truncated",
  empty: "empty",
  unreadable: "unreadable"
} as const

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

/**
 * How much of a Memory source reached the prompt: `passage` is the part a search matched,
 * chosen rather than cut. `cut` and `dropped` name the limit in `reason`. For a list of pages,
 * `cut` means folders were folded to fit, and past that, lines were left out from the end.
 */
export type RunMemoryOutcome = "whole" | "passage" | "cut" | "dropped"

/**
 * The allowance that cut or dropped a Memory source. Each source has its own allowance in the
 * run's Memory block and takes none from another:
 * - `standing_page_allowance`: a standing-facts page's: the size its writers keep it to, and a
 *   size in bytes.
 * - `index_allowance`: the Space context's share for the list of its pages, or the Memory
 *   index's in a composition stored before it was removed.
 * - `space_page_allowance`: the Space context's share for its Memory page.
 * - `recall_allowance`: the recalled pages'.
 */
export type RunMemoryCutReason =
  | "standing_page_allowance"
  | "index_allowance"
  | "space_page_allowance"
  | "recall_allowance"

/**
 * The row of the Memory table a Run was sent by: `owner` (a person's chat turn) gets standing
 * facts, its Space and recall; `worker` (a helper, Task worker, Space review or a Run with no
 * recorded actor) gets standing facts only. Automations get no Memory and record none.
 */
export type RunMemoryReader = "owner" | "worker"

/**
 * The Space context, in `bytes`. The list of the Space's other pages is a section of its own,
 * recorded as an index whose `root` is the Space's folder. `page_id` names its Memory page when
 * it has one, and `outcome` says how much of that page the Space context held.
 */
export interface RunMemorySpaceSource extends JsonRecord {
  readonly kind: "space"
  readonly space_id: string
  readonly page_id: string | null
  readonly version: string | null
  readonly bytes: number
  readonly outcome: RunMemoryOutcome
  readonly reason: RunMemoryCutReason | null
}

interface RunMemoryPageFields extends JsonRecord {
  readonly page_id: string
  readonly version: string
  readonly bytes: number
  readonly outcome: RunMemoryOutcome
  readonly reason: RunMemoryCutReason | null
}

/** A standing-facts page, at `version`. */
export interface RunMemoryCoreSource extends RunMemoryPageFields {
  readonly kind: "core"
}

/**
 * What a recalled page is: `knowledge`, kept current by chats and upkeep; a `record`, a dated
 * report or an import, kept as its producer wrote it; or the `contract` of a record folder.
 */
export type RunMemoryRecallRole = "knowledge" | "record" | "contract"

/** A page the recall chose, at `version`. */
export interface RunMemoryRecalledSource extends RunMemoryPageFields {
  readonly kind: "recalled"
  /** Absent in a composition stored before recall told records apart, so not known. */
  readonly role?: RunMemoryRecallRole
}

/**
 * The generated list of the pages under `root`: `listed` pages had a line each, and each folded
 * folder was counted as one line of `pages`. A composition stored before the Memory index was
 * removed may also hold an index of all of Memory, with `root` "".
 */
export interface RunMemoryIndexSource extends JsonRecord {
  readonly kind: "index"
  readonly root: string
  readonly listed: number
  readonly folded: ReadonlyArray<{ readonly folder: string; readonly pages: number }>
  readonly bytes: number
  readonly outcome: RunMemoryOutcome
  readonly reason: RunMemoryCutReason | null
}

/** One Memory source a Run was sent before the model ran: identity and bytes, never text. */
export type RunMemorySource =
  | RunMemorySpaceSource
  | RunMemoryCoreSource
  | RunMemoryRecalledSource
  | RunMemoryIndexSource

/**
 * The allowances, in UTF-8 bytes, a Memory block was composed under: `standing_page` for each
 * standing-facts page and `standing_frame` for their note and heading; the Space context in
 * `space`, with `space_instructions` and `space_page` its shares, and `space_page_list` beside
 * it; `recall`. `index` is the Memory index's allowance, present only in a budget stored before
 * the Memory index was removed.
 */
export interface RunMemoryBudget extends JsonRecord {
  readonly standing_page: number
  readonly standing_frame: number
  readonly index?: number
  readonly space: number
  readonly space_instructions: number
  readonly space_page: number
  readonly space_page_list: number
  readonly recall: number
}

/**
 * One composition of a Run's Memory block: what every model request was sent from it until
 * the Run composed its context again. All pages were read at Memory `revision` (null when
 * Memory could not be read). `query` is the owner's recent typed text as far as the recall's
 * word search reads it (the meaning search embeds all of it); null when no recall ran.
 */
export interface RunMemoryContext extends JsonRecord {
  readonly reader: RunMemoryReader
  readonly revision: string | null
  readonly query: string | null
  readonly budget?: RunMemoryBudget
  readonly sources: ReadonlyArray<RunMemorySource>
}

export type RunMemoryComposition = RunMemoryContext & { readonly budget: RunMemoryBudget }

export const RUN_STOP_REASON = { unstated: "unstated", stated: "stated" } as const

export type RunStopReason =
  | { readonly kind: typeof RUN_STOP_REASON.unstated }
  | { readonly kind: typeof RUN_STOP_REASON.stated; readonly reason: string }

export const RUN_RESULT = { none: "none", on_time: "on_time", late: "late" } as const

export type RunResultState =
  | { readonly kind: typeof RUN_RESULT.none }
  | { readonly kind: typeof RUN_RESULT.on_time; readonly result: RunTerminalResult }
  | {
      readonly kind: typeof RUN_RESULT.late
      readonly result: RunTerminalResult
      readonly at: string
    }

export const RUN_FAILURE = { none: "none", failed: "failed" } as const

export type RunFailure =
  | { readonly kind: typeof RUN_FAILURE.none }
  | ({ readonly kind: typeof RUN_FAILURE.failed } & RunError)

export const RUN_EVENTS_SEEN = { none: "none", through: "through" } as const

export type RunEventsSeen =
  | { readonly kind: typeof RUN_EVENTS_SEEN.none }
  | { readonly kind: typeof RUN_EVENTS_SEEN.through; readonly sequence: number }

export const RUN_MODEL = { unrecorded: "unrecorded", model: "model" } as const

export type RunModel =
  | { readonly kind: typeof RUN_MODEL.unrecorded }
  | { readonly kind: typeof RUN_MODEL.model; readonly model_id: string }

export const RUN_REASONING = { default: "default", effort: "effort" } as const

export type RunReasoning =
  | { readonly kind: typeof RUN_REASONING.default }
  | { readonly kind: typeof RUN_REASONING.effort; readonly effort: string }

export const RUN_CLIENT = { none: "none", client: "client" } as const

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

export const RUN_TRACE = { kept: "kept", removed: "removed" } as const

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
  /** Reported US dollars (`RunUsage.cost`); absent when any call counted reported none. */
  readonly cost?: number
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
  /** Reported US dollars (`RunUsage.cost`); absent when any Run counted has none. */
  readonly cost?: number
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
