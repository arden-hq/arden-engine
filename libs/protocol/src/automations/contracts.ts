import type { JsonRecord, JsonValue } from "../common/json.js"
export type {
  AutomationCountThrough,
  AutomationEventProducer,
  AutomationTriggerContext
} from "./occurrence.js"
import type { AutomationEventType } from "./triggers.js"
import type {
  AutomationTrigger,
  AutomationTriggerInput,
  AutomationTriggerSpec
} from "./trigger-contracts.js"
export * from "./trigger-contracts.js"

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

export interface AutomationPendingCard extends JsonRecord {
  readonly run_id: string
  readonly tool_call_id: string
  readonly session_id: string
  readonly destination_session_id: string
}

export type AutomationPendingApprovals =
  | { readonly kind: "none" }
  | { readonly kind: "pending"; readonly count: number; readonly first: AutomationPendingCard }

export type AutomationValueOperator =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "starts_with"
  | "ends_with"

export type AutomationConditionOperator = AutomationValueOperator | "in" | "exists"

export type AutomationComparisonCondition =
  | {
      readonly kind: "compare"
      readonly field: string
      readonly op: AutomationValueOperator
      readonly value: JsonValue
    }
  | {
      readonly kind: "compare"
      readonly field: string
      readonly op: "in"
      readonly value: ReadonlyArray<JsonValue>
    }
  | { readonly kind: "compare"; readonly field: string; readonly op: "exists" }

export type AutomationCondition =
  | AutomationComparisonCondition
  | { readonly kind: "and"; readonly conditions: ReadonlyArray<AutomationCondition> }
  | { readonly kind: "or"; readonly conditions: ReadonlyArray<AutomationCondition> }
  | { readonly kind: "not"; readonly condition: AutomationCondition }

export type SettableAutomationToolScope = "read_only" | "reports" | "browser" | "all"

/** Stored scopes are server-owned keys, never client-maintained tool lists. */
export type AutomationToolScope =
  | SettableAutomationToolScope
  | "space"
  | "memory_capture"
  | "chat_summary"

/** A system Automation setting the user may change; each one resets to its handler's default. */
export type SystemAutomationSetting = "triggers" | "model" | "prompt" | "enabled"

/** What a system Automation lets the user change, and what they changed. */
export interface SystemAutomationSettings extends JsonRecord {
  /** The handler's triggers, which `triggers` equals unless "triggers" is changed. */
  readonly default_triggers: ReadonlyArray<AutomationTriggerSpec>
  /** No "model" for a fork: it runs on each source chat's model. No "prompt" for a job that runs no model. */
  readonly settable: ReadonlyArray<SystemAutomationSetting>
  /** Settings that differ from the default: another trigger list, a model, its own instructions, or a pause. */
  readonly changed: ReadonlyArray<SystemAutomationSetting>
}

interface OwnAutomationChat extends JsonRecord {
  readonly kind: "own"
  readonly session_id: string
}

export type AutomationOwnChat =
  | { readonly kind: "none" }
  | { readonly kind: "chat"; readonly session_id: string }

interface YourAutomationChat extends JsonRecord {
  readonly kind: "yours"
  readonly session_id: string
  readonly own_chat: AutomationOwnChat
}

export type AutomationChat = OwnAutomationChat | YourAutomationChat

export type SystemAutomationChat = { readonly kind: "none" } | AutomationChat

export type AutomationDescription =
  | { readonly kind: "none" }
  | { readonly kind: "manual"; readonly text: string }
  | { readonly kind: "generated"; readonly text: string }

export type AutomationModel =
  | { readonly kind: "inherited" }
  | { readonly kind: "chosen"; readonly model_id: string }

export type AutomationLastRun =
  | { readonly kind: "never" }
  | { readonly kind: "ran"; readonly at: string }

export type AutomationLastResult =
  | { readonly kind: "none" }
  | { readonly kind: "text"; readonly text: string }

export type AutomationNextRun =
  | { readonly kind: "unscheduled" }
  | { readonly kind: "scheduled"; readonly at: string }

export type AutomationActivity =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly since: string }
  | { readonly kind: "waiting"; readonly since: string; readonly on: AutomationWaitingOn }

export type AutomationCooldown =
  | { readonly kind: "none" }
  | { readonly kind: "minutes"; readonly minutes: number }

export interface AutomationFields extends JsonRecord {
  readonly task_id: string
  readonly automation_ref: string
  readonly name: string
  readonly description: AutomationDescription
  readonly prompt: string
  readonly model: AutomationModel
  readonly triggers: ReadonlyArray<AutomationTrigger>
  readonly enabled: boolean
  readonly created_at: string
  readonly last_run: AutomationLastRun
  readonly next_run: AutomationNextRun
  readonly recent_statuses: ReadonlyArray<AutomationRunStatus>
  readonly last_result: AutomationLastResult
  readonly auto_approve: boolean
  readonly activity: AutomationActivity
  readonly waiting_events: number
  readonly pending_approvals: AutomationPendingApprovals
  readonly builtin: boolean
  readonly cooldown: AutomationCooldown
  readonly old_conditions: ReadonlyArray<AutomationOldCondition>
  readonly tool_scope: AutomationToolScope
  readonly tool_scope_label: string
}

export interface UserAutomation extends AutomationFields {
  readonly kind: "user"
  readonly chat: AutomationChat
  readonly history: AutomationHistory
}

export interface SystemAutomation extends AutomationFields {
  readonly kind: "system"
  readonly handler: string
  readonly chat: SystemAutomationChat
  readonly manual_run: boolean
  readonly settings: SystemAutomationSettings
}

export type Automation = UserAutomation | SystemAutomation

export type AutomationDescriptionInput =
  | { readonly kind: "none" }
  | { readonly kind: "manual"; readonly text: string }

export interface CreateAutomationInput {
  readonly chat: AutomationChatChoice
  readonly name: string
  readonly prompt: string
  readonly description: AutomationDescriptionInput
  readonly model: AutomationModel
  readonly history: AutomationHistory
  readonly triggers: ReadonlyArray<AutomationTriggerSpec>
  readonly enabled: boolean
  readonly approval_mode: "read_only" | "ask" | "safe" | "allow"
  readonly cooldown: AutomationCooldown
}

export type AutomationChange =
  | { readonly kind: "chat"; readonly chat: AutomationChatChoice }
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "prompt"; readonly prompt: string }
  | { readonly kind: "description"; readonly description: string }
  | { readonly kind: "model"; readonly model: AutomationModel }
  | { readonly kind: "history"; readonly history: AutomationHistory }
  | { readonly kind: "triggers"; readonly triggers: ReadonlyArray<AutomationTriggerInput> }
  | { readonly kind: "enabled"; readonly enabled: boolean }
  | { readonly kind: "cooldown"; readonly cooldown: AutomationCooldown }

export interface UpdateAutomationInput {
  readonly changes: ReadonlyArray<AutomationChange>
}

/** Puts one changed system setting back to its handler's default. */
export interface ResetAutomationSettingInput {
  readonly setting: SystemAutomationSetting
}

export interface AutomationListResponse extends JsonRecord {
  readonly automations: ReadonlyArray<Automation>
}

export type AutomationEventRouteOptions =
  | { readonly kind: "live" }
  | { readonly kind: "after"; readonly afterSeq: number }

export interface AutomationRunsRouteOptions {
  readonly limit: number
}

export type AutomationRunChat =
  | { readonly kind: "none" }
  | { readonly kind: "chat"; readonly session_id: string }
  | { readonly kind: "chat_run"; readonly session_id: string; readonly run_id: string }

export type AutomationRunOutput =
  | { readonly kind: "none" }
  | { readonly kind: "result"; readonly result: string }
  | { readonly kind: "error"; readonly error: string }
  | { readonly kind: "result_and_error"; readonly result: string; readonly error: string }

interface AutomationRunFields extends JsonRecord {
  readonly id: number
  readonly task_id: string
  readonly context_mode: AutomationContextMode
  readonly started_at: string
}

export interface RunningAutomationRun extends AutomationRunFields {
  readonly status: "running"
  readonly chat: AutomationRunChat
  readonly output: AutomationRunOutput
}

export interface EndedAutomationRun extends AutomationRunFields {
  readonly status: Exclude<AutomationRunStatus, "running">
  readonly ended_at: string
  readonly chat: AutomationRunChat
  readonly output: AutomationRunOutput
}

export interface SkippedAutomationRun extends AutomationRunFields {
  readonly status: "skipped"
  readonly ended_at: string
  readonly result: string
  readonly skip: AutomationRunSkip
}

export type AutomationRun = RunningAutomationRun | EndedAutomationRun | SkippedAutomationRun

export interface AutomationRunSkip extends JsonRecord {
  readonly reason: "prefilter"
  readonly backend: string
  readonly event: AutomationSkippedEvent
  readonly asked: ReadonlyArray<string>
  readonly run_with_event: AutomationSkipRunWithEvent
}

export interface AutomationSkippedEvent extends JsonRecord {
  readonly event_type: AutomationEventType
  readonly title: string
  readonly link: AutomationEventLink
}

export type AutomationEventLink =
  | { readonly kind: "none" }
  | { readonly kind: "chat"; readonly session_id: string; readonly session_ref: string }
  | { readonly kind: "memory_page"; readonly path: string }
  | { readonly kind: "task"; readonly item_id: string }
  | { readonly kind: "connection_item"; readonly item_id: string }
  | { readonly kind: "connection_item_with_page"; readonly item_id: string; readonly url: string }

export type AutomationSkipRunWithEvent =
  | { readonly kind: "not_asked" }
  | { readonly kind: "queued"; readonly at: string }
  | { readonly kind: "started"; readonly at: string; readonly run_id: number }
  | { readonly kind: "cancelled"; readonly at: string }

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
