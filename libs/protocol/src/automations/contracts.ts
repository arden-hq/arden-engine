import type { JsonRecord, JsonValue } from "../common/json.js"
export {
  AUTOMATION_OCCURRENCE,
  type AutomationCountThrough,
  type AutomationEventProducer,
  type AutomationOccurrence,
  type AutomationTriggerContext
} from "./occurrence.js"
import type { AutomationEventType } from "./triggers.js"
import type {
  AutomationTrigger,
  AutomationTriggerInput,
  AutomationTriggerSpec
} from "./trigger-contracts.js"
export * from "./trigger-contracts.js"

export const AUTOMATION_RUN_STATUS = {
  running: "running",
  completed: "completed",
  blocked: "blocked",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "interrupted"
} as const
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUS)[keyof typeof AUTOMATION_RUN_STATUS]
export const AUTOMATION_CONTEXT_MODE = {
  fresh: "fresh",
  continue: "continue",
  fork: "fork"
} as const
export type AutomationContextMode =
  (typeof AUTOMATION_CONTEXT_MODE)[keyof typeof AUTOMATION_CONTEXT_MODE]

export const AUTOMATION_HISTORY = { fresh: "fresh", chat: "chat" } as const
export type AutomationHistory = (typeof AUTOMATION_HISTORY)[keyof typeof AUTOMATION_HISTORY]

export const AUTOMATION_CHAT_CHOICE = { own: "own", yours: "yours" } as const
export type AutomationChatChoice =
  | { readonly kind: typeof AUTOMATION_CHAT_CHOICE.own }
  | { readonly kind: typeof AUTOMATION_CHAT_CHOICE.yours; readonly session_id: string }

export const AUTOMATION_WAITING_ON = { approval: "approval", connection: "connection" } as const
export type AutomationWaitingOn = (typeof AUTOMATION_WAITING_ON)[keyof typeof AUTOMATION_WAITING_ON]

export interface AutomationPendingCard extends JsonRecord {
  readonly run_id: string
  readonly tool_call_id: string
  readonly session_id: string
  readonly destination_session_id: string
}

export type AutomationPendingApprovals =
  | { readonly kind: "none" }
  | { readonly kind: "pending"; readonly count: number; readonly first: AutomationPendingCard }

export const CONDITION_OPERATOR = {
  eq: "eq",
  ne: "ne",
  gt: "gt",
  gte: "gte",
  lt: "lt",
  lte: "lte",
  contains: "contains",
  starts_with: "starts_with",
  ends_with: "ends_with",
  in: "in",
  exists: "exists"
} as const

export type AutomationConditionOperator =
  (typeof CONDITION_OPERATOR)[keyof typeof CONDITION_OPERATOR]

export type AutomationValueOperator = Exclude<
  AutomationConditionOperator,
  typeof CONDITION_OPERATOR.in | typeof CONDITION_OPERATOR.exists
>

export const AUTOMATION_CONDITION = {
  compare: "compare",
  and: "and",
  or: "or",
  not: "not"
} as const

export type AutomationComparisonCondition =
  | {
      readonly kind: typeof AUTOMATION_CONDITION.compare
      readonly field: string
      readonly op: AutomationValueOperator
      readonly value: JsonValue
    }
  | {
      readonly kind: typeof AUTOMATION_CONDITION.compare
      readonly field: string
      readonly op: typeof CONDITION_OPERATOR.in
      readonly value: ReadonlyArray<JsonValue>
    }
  | {
      readonly kind: typeof AUTOMATION_CONDITION.compare
      readonly field: string
      readonly op: typeof CONDITION_OPERATOR.exists
    }

export type AutomationCondition =
  | AutomationComparisonCondition
  | {
      readonly kind: typeof AUTOMATION_CONDITION.and
      readonly conditions: ReadonlyArray<AutomationCondition>
    }
  | {
      readonly kind: typeof AUTOMATION_CONDITION.or
      readonly conditions: ReadonlyArray<AutomationCondition>
    }
  | { readonly kind: typeof AUTOMATION_CONDITION.not; readonly condition: AutomationCondition }

export type SettableAutomationToolScope = "read_only" | "reports" | "browser" | "all"

export type AutomationToolScope =
  | SettableAutomationToolScope
  | "space"
  | "memory_capture"
  | "chat_summary"

export const SYSTEM_AUTOMATION_SETTING = {
  triggers: "triggers",
  model: "model",
  prompt: "prompt",
  enabled: "enabled"
} as const
export type SystemAutomationSetting =
  (typeof SYSTEM_AUTOMATION_SETTING)[keyof typeof SYSTEM_AUTOMATION_SETTING]

export interface SystemAutomationSettings extends JsonRecord {
  readonly default_triggers: ReadonlyArray<AutomationTriggerSpec>
  readonly settable: ReadonlyArray<SystemAutomationSetting>
  readonly changed: ReadonlyArray<SystemAutomationSetting>
}

interface OwnAutomationChat extends JsonRecord {
  readonly kind: typeof AUTOMATION_CHAT_CHOICE.own
  readonly session_id: string
}

export type AutomationOwnChat =
  | { readonly kind: "none" }
  | { readonly kind: "chat"; readonly session_id: string }

interface YourAutomationChat extends JsonRecord {
  readonly kind: typeof AUTOMATION_CHAT_CHOICE.yours
  readonly session_id: string
  readonly own_chat: AutomationOwnChat
}

export type AutomationChat = OwnAutomationChat | YourAutomationChat

export type SystemAutomationChat = { readonly kind: "none" } | AutomationChat
export const AUTOMATION_DESCRIPTION = {
  none: "none",
  manual: "manual",
  generated: "generated"
} as const

export type AutomationDescription =
  | { readonly kind: typeof AUTOMATION_DESCRIPTION.none }
  | { readonly kind: typeof AUTOMATION_DESCRIPTION.manual; readonly text: string }
  | { readonly kind: typeof AUTOMATION_DESCRIPTION.generated; readonly text: string }

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
  | {
      readonly kind: "waiting"
      readonly since: string
      readonly on: AutomationWaitingOn
    }

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
  readonly status: typeof AUTOMATION_RUN_STATUS.running
  readonly chat: AutomationRunChat
  readonly output: AutomationRunOutput
}

export interface EndedAutomationRun extends AutomationRunFields {
  readonly status: Exclude<AutomationRunStatus, typeof AUTOMATION_RUN_STATUS.running>
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

export const AUTOMATION_RUN_SKIP_REASON = { prefilter: "prefilter" } as const

export interface AutomationRunSkip extends JsonRecord {
  readonly reason: typeof AUTOMATION_RUN_SKIP_REASON.prefilter
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

export const AUTOMATION_EVENT_LINK = {
  none: "none",
  chat: "chat",
  memory_page: "memory_page",
  task: "task",
  connection_item: "connection_item",
  connection_item_with_page: "connection_item_with_page"
} as const

export type AutomationEventLink =
  | { readonly kind: typeof AUTOMATION_EVENT_LINK.none }
  | {
      readonly kind: typeof AUTOMATION_EVENT_LINK.chat
      readonly session_id: string
      readonly session_ref: string
    }
  | { readonly kind: typeof AUTOMATION_EVENT_LINK.memory_page; readonly path: string }
  | { readonly kind: typeof AUTOMATION_EVENT_LINK.task; readonly item_id: string }
  | { readonly kind: typeof AUTOMATION_EVENT_LINK.connection_item; readonly item_id: string }
  | {
      readonly kind: typeof AUTOMATION_EVENT_LINK.connection_item_with_page
      readonly item_id: string
      readonly url: string
    }

export type AutomationSkipRunWithEvent =
  | { readonly kind: "not_asked" }
  | { readonly kind: "queued"; readonly at: string }
  | { readonly kind: "started"; readonly at: string; readonly run_id: number }
  | { readonly kind: "cancelled"; readonly at: string }

export interface AutomationOldCondition extends JsonRecord {
  readonly trigger_id: string
  readonly words: string
  readonly readable: boolean
}

export interface AutomationRunsResponse extends JsonRecord {
  readonly runs: ReadonlyArray<AutomationRun>
}

export const AUTOMATION_CATALOG_FIELD_TYPE = {
  int: "int",
  float: "float",
  str: "str",
  bool: "bool",
  list: "list"
} as const
export type AutomationCatalogFieldType =
  (typeof AUTOMATION_CATALOG_FIELD_TYPE)[keyof typeof AUTOMATION_CATALOG_FIELD_TYPE]

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

export const HOME_LETTER_AUTOMATION_REF = "builtin-home-letter"
