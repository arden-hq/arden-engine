import type { JsonRecord, JsonValue } from "../common/json.js"
export type { AutomationTriggerContext } from "./occurrence.js"
import type { AutomationEventType } from "./triggers.js"

export type AutomationDescriptionSource = "manual" | "generated"
/** A run's outcome as the wire reports it. `blocked`: the run ended with the
 *  agent's own report that it could not finish (`report` blocked), so it is
 *  never a success; stored runs say `completed`, and reads derive `blocked`.
 *  `interrupted`: a restart (or a lost owner) stopped the run before it
 *  finished — routine, not a failure. */
export type AutomationRunStatus =
  | "running"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled"
  | "interrupted"
/** `fork`: the run starts from another chat's history in its own hidden chat. */
export type AutomationContextMode = "fresh" | "continue" | "fork"
/** What each run of a user's Automation knows: "fresh" starts with no history,
 *  "chat" reads its chat's history. */
export type AutomationHistory = "fresh" | "chat"
/** Where a user's Automation lives and reports: its own chat, or one of the user's
 *  chats. A Space comes only from the chat. */
export type AutomationChatChoice =
  | { readonly kind: "own" }
  | { readonly kind: "yours"; readonly session_id: string }
export type AutomationWaitingOn = "approval" | "connection"

/** Pending card identity survives the Run that created it. */
export interface AutomationPendingApprovals extends JsonRecord {
  readonly count: number
  readonly first: JsonRecord & {
    readonly run_id: string
    readonly tool_call_id: string
    readonly session_id: string
    /** The chat the card shows in. */
    readonly destination_session_id: string
  }
}

export type AutomationConditionOperator =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "in"
  | "exists"

export interface AutomationComparisonCondition extends JsonRecord {
  readonly kind: "compare"
  readonly field: string
  readonly op: AutomationConditionOperator
  readonly value?: JsonValue
}

export interface AutomationAllCondition extends JsonRecord {
  readonly kind: "and"
  readonly conditions: ReadonlyArray<AutomationCondition>
}

export interface AutomationAnyCondition extends JsonRecord {
  readonly kind: "or"
  readonly conditions: ReadonlyArray<AutomationCondition>
}

export interface AutomationNotCondition extends JsonRecord {
  readonly kind: "not"
  readonly condition: AutomationCondition
}

export type AutomationCondition =
  | AutomationComparisonCondition
  | AutomationAllCondition
  | AutomationAnyCondition
  | AutomationNotCondition

export interface AutomationComparisonConditionInput {
  readonly kind: "compare"
  readonly field: string
  readonly op: AutomationConditionOperator
  readonly value?: JsonValue
}

export interface AutomationAllConditionInput {
  readonly kind: "and"
  readonly conditions: ReadonlyArray<AutomationConditionInput>
}

export interface AutomationAnyConditionInput {
  readonly kind: "or"
  readonly conditions: ReadonlyArray<AutomationConditionInput>
}

export interface AutomationNotConditionInput {
  readonly kind: "not"
  readonly condition: AutomationConditionInput
}

export type AutomationConditionInput =
  | AutomationComparisonConditionInput
  | AutomationAllConditionInput
  | AutomationAnyConditionInput
  | AutomationNotConditionInput

export type SettableAutomationToolScope = "read_only" | "reports" | "browser" | "all"

/** Stored scopes are server-owned keys, never client-maintained tool lists. */
export type AutomationToolScope =
  | SettableAutomationToolScope
  | "space"
  | "memory_capture"
  | "chat_summary"

/**
 * A stored trigger's stable id ("t1", "t2", ...), unique within its Automation.
 * The store gives every trigger it saves one. An update that sends a trigger
 * with its id edits that trigger and keeps each field it leaves out; one sent
 * without an id is new (`mergeTriggerInputs`).
 */
interface TriggerIdField {
  readonly id?: string
}

interface TimeTriggerFields extends TriggerIdField {
  readonly type: "time"
  readonly at?: string
  readonly on?: string
  readonly days?: string
  readonly every?: string
  readonly start?: string
  readonly end?: string
}

export interface TimeAutomationTrigger extends JsonRecord, TimeTriggerFields {}
export interface TimeAutomationTriggerInput extends TimeTriggerFields {}

/**
 * The app event an `mcp.event` trigger waits for: one event a connected MCP
 * server lists, and the arguments its subscription opens with (filters the
 * server defines in that event's input schema).
 */
export interface McpEventSelector extends JsonRecord {
  readonly server: string
  readonly event: string
  readonly arguments: Readonly<Record<string, JsonValue>>
}

/** Arguments left out are none. */
export interface McpEventSelectorInput {
  readonly server: string
  readonly event: string
  readonly arguments?: Readonly<Record<string, JsonValue>>
}

interface EventTriggerFields extends TriggerIdField {
  readonly type: "event"
  readonly event_type: AutomationEventType
  readonly lead_minutes?: number
  /** Only for mcp.event, where it is required. */
  readonly mcp_event?: McpEventSelector
  /** An old field condition: still checked, no longer written by the agent tools. */
  readonly condition?: AutomationCondition | null
  /** "Run only if": one plain sentence the event must match before a run starts. */
  readonly run_only_if?: string
}

export interface EventAutomationTrigger extends JsonRecord, EventTriggerFields {}
/** Sent with its `id`, a field left out keeps the stored value and null clears it. */
export interface EventAutomationTriggerInput extends TriggerIdField {
  readonly type: "event"
  readonly event_type: AutomationEventType
  readonly lead_minutes?: number | null
  readonly mcp_event?: McpEventSelectorInput | null
  readonly condition?: AutomationConditionInput | null
  /** Null, or absent on a new trigger: every matching event runs. */
  readonly run_only_if?: string | null
}

export interface IdleAutomationTrigger extends JsonRecord, TriggerIdField {
  readonly type: "idle"
  readonly idle_minutes: number
}

export interface IdleAutomationTriggerInput extends TriggerIdField {
  readonly type: "idle"
  readonly idle_minutes: number
}

export interface CountAutomationTrigger extends JsonRecord, TriggerIdField {
  readonly type: "count"
  readonly every_n: number
}

export interface CountAutomationTriggerInput extends TriggerIdField {
  readonly type: "count"
  readonly every_n: number
}

export type AutomationTrigger =
  | TimeAutomationTrigger
  | EventAutomationTrigger
  | IdleAutomationTrigger
  | CountAutomationTrigger

export type AutomationTriggerInput =
  | TimeAutomationTriggerInput
  | EventAutomationTriggerInput
  | IdleAutomationTriggerInput
  | CountAutomationTriggerInput

/** A system Automation setting the user may change; each one resets to its handler's default. */
export type SystemAutomationSetting = "triggers" | "model" | "prompt" | "enabled"

/** What a system Automation lets the user change, and what they changed. */
export interface SystemAutomationSettings extends JsonRecord {
  /** The handler's triggers, which `triggers` equals unless "triggers" is changed. */
  readonly default_triggers: ReadonlyArray<AutomationTrigger>
  /** No "model" for a fork: it runs on each source chat's model. No "prompt" for a job that runs no model. */
  readonly settable: ReadonlyArray<SystemAutomationSetting>
  /** Settings that differ from the default: another trigger list, a model, its own instructions, or a pause. */
  readonly changed: ReadonlyArray<SystemAutomationSetting>
}

interface OwnAutomationChat extends JsonRecord {
  readonly kind: "own"
  readonly session_id: string
}

interface YourAutomationChat extends JsonRecord {
  readonly kind: "yours"
  readonly session_id: string
  /** Its own chat, where a run that starts fresh works and whose action mode it
   *  uses; null while it has none. */
  readonly own_session_id: string | null
}

/** The chat an Automation lives and reports in: its own, or one of the user's. */
export type AutomationChat = OwnAutomationChat | YourAutomationChat

/** Public automation projection. Internal retry claims are deliberately absent. */
export interface Automation extends JsonRecord {
  readonly task_id: string
  /** Stable model-facing identity. */
  readonly automation_ref?: string
  readonly name: string
  readonly description: string | null
  readonly description_source: AutomationDescriptionSource | null
  readonly prompt: string
  readonly model: string | null
  /** Null for a system Automation without a chat (a fork, or no model). */
  readonly chat: AutomationChat | null
  /** Null for a system Automation, whose handler owns what a run reads. */
  readonly history: AutomationHistory | null
  readonly triggers: ReadonlyArray<AutomationTrigger>
  readonly enabled: boolean
  readonly created_at: string
  readonly last_run_at: string | null
  readonly next_run_at: string | null
  readonly recent_statuses: ReadonlyArray<AutomationRunStatus>
  /** The newest of those runs, by id: a later run, a later id. Null before
   *  the first. */
  readonly latest_run_id: number | null
  readonly last_result: string | null
  readonly auto_approve: boolean
  readonly running_since: string | null
  readonly waiting_on: AutomationWaitingOn | null
  /** Event rows matched and not yet started; a paused Automation keeps them for its resume. */
  readonly waiting_events: number
  readonly pending_approvals: AutomationPendingApprovals | null
  readonly handler: string | null
  readonly builtin: boolean
  readonly cooldown_minutes: number | null
  /** The old field conditions of its event triggers, in words, for a read-only line. */
  readonly old_conditions: ReadonlyArray<AutomationOldCondition>
  readonly tool_scope: AutomationToolScope
  readonly tool_scope_label: string
  /** False when a run needs a firing's input (a fork needs the chat that went quiet). */
  readonly manual_run: boolean
  /** Null for a user's Automation. */
  readonly system: SystemAutomationSettings | null
}

/**
 * Consumer-facing creation input. The encoder adds retry identity internally
 * and returns one reusable request body.
 */
export interface CreateAutomationInput {
  /** Omitted: its own chat. */
  readonly chat?: AutomationChatChoice
  readonly name: string
  readonly prompt: string
  readonly description?: string
  readonly model?: string | null
  readonly history: AutomationHistory
  readonly triggers: ReadonlyArray<AutomationTriggerInput>
  readonly enabled?: boolean
  readonly approval_mode?: "read_only" | "ask" | "safe" | "allow"
  readonly cooldown_minutes?: number | null
}

export interface UpdateAutomationInput {
  readonly chat?: AutomationChatChoice
  readonly name?: string
  readonly prompt?: string
  readonly description?: string
  readonly model?: string | null
  readonly history?: AutomationHistory
  readonly triggers?: ReadonlyArray<AutomationTriggerInput>
  readonly enabled?: boolean
  readonly cooldown_minutes?: number | null
}

/** Puts one changed system setting back to its handler's default. */
export interface ResetAutomationSettingInput {
  readonly setting: SystemAutomationSetting
}

export interface AutomationListResponse extends JsonRecord {
  readonly automations: ReadonlyArray<Automation>
}

export interface AutomationEventRouteOptions {
  readonly afterSeq?: number
}

export interface AutomationRunsRouteOptions {
  readonly limit?: number
}

export interface AutomationRun extends JsonRecord {
  readonly id: number
  readonly task_id: string
  readonly chat_run_id: string | null
  readonly chat_session_id: string | null
  /** Captured when the run was admitted; later Automation edits do not change it. */
  readonly context_mode: AutomationContextMode
  readonly started_at: string
  readonly ended_at: string | null
  readonly status: AutomationRunStatus
  readonly result: string | null
  readonly error: string | null
  /** Set when the occurrence ended before any run; null for every run that started. */
  readonly skipped: AutomationRunSkip | null
}

/** The "Run only if" sentences said no to an event wake: no agent ran. */
export interface AutomationRunSkip extends JsonRecord {
  readonly reason: "prefilter"
  /** `llm` for the Helper, else the decision endpoint's id. */
  readonly backend: string
  readonly event: AutomationSkippedEvent
  /** The "Run only if" sentences the event was checked against, as they read
   *  then; empty on a skip recorded before they were kept. */
  readonly asked: ReadonlyArray<string>
  /** Set once you ran the Automation with this event; null until then, and
   *  again once that run was cancelled before it started. */
  readonly ran: AutomationSkipRan | null
  /** When your last run with this event was cancelled before it started (the
   *  Automation stopped or its Space was archived); null when none was. */
  readonly cancelled: AutomationSkipCancelled | null
}

/** The skipped event in short: its type, a readable title, and where it points. */
export interface AutomationSkippedEvent extends JsonRecord {
  readonly event_type: AutomationEventType
  readonly title: string
  readonly link: AutomationEventLink | null
}

/** Where an event points: the chat that went quiet, a changed Memory page, the
 *  Task that changed, or the fetched mail or GitHub item (its web page when it has one). */
export type AutomationEventLink =
  | { readonly kind: "chat"; readonly session_id: string; readonly session_ref: string }
  | { readonly kind: "memory_page"; readonly path: string }
  | { readonly kind: "task"; readonly item_id: string }
  | { readonly kind: "connection_item"; readonly item_id: string; readonly url: string | null }

/** "Ran by you": when you asked for the run, and its run once it started (null while queued). */
export interface AutomationSkipRan extends JsonRecord {
  readonly at: string
  readonly run_id: number | null
}

/** A run with a skipped event that was cancelled before it started. */
export interface AutomationSkipCancelled extends JsonRecord {
  readonly at: string
}

/** An event trigger's old field condition in words, by the trigger's id.
 *  `readable`: every field it reads has words, so the sentence can stand as the
 *  trigger's "Run only if"; otherwise it is shown but never kept as one. */
export interface AutomationOldCondition extends JsonRecord {
  readonly trigger_id: string
  readonly words: string
  readonly readable: boolean
}

export interface AutomationRunsResponse extends JsonRecord {
  readonly runs: ReadonlyArray<AutomationRun>
}

export type AutomationCatalogFieldType = "int" | "float" | "str" | "bool" | "list"

export interface AutomationEventCatalogField extends JsonRecord {
  readonly field: string
  readonly label: string
  readonly hint: string
  readonly type: AutomationCatalogFieldType
  readonly operators: ReadonlyArray<AutomationConditionOperator>
}

export interface AutomationEventCatalogEntry extends JsonRecord {
  readonly event_type: AutomationEventType
  readonly label: string
  readonly fields: ReadonlyArray<AutomationEventCatalogField>
}

export interface AutomationEventCatalogResponse extends JsonRecord {
  readonly events: ReadonlyArray<AutomationEventCatalogEntry>
}

export interface ToggleAutomationResponse extends JsonRecord {
  readonly enabled: boolean
}

export interface RunAutomationResponse extends JsonRecord {
  readonly status: "started"
}

export interface DeleteAutomationResponse extends JsonRecord {
  readonly status: "deleted"
}

/** The built-in Automation that writes the Home letter. Home's "Write now"
 *  runs it; the server seeds it under this id. */
export const HOME_LETTER_AUTOMATION_REF = "builtin-home-letter"

/** The chat whose action mode and Local folders a user's Automation's runs use: the
 *  chat they work in, or the source chat of the copy a run that reads yours works in. */
export const automationPermissionChat = (
  automation: Pick<Automation, "chat" | "history">
): string | null => {
  const chat = automation.chat
  if (chat === null) return null
  if (chat.kind === "own" || automation.history === "chat") return chat.session_id
  return chat.own_session_id
}
