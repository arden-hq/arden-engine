import { ROLE } from "@arden-hq/std/message-vocabulary"
import type { AutomationEvent, JsonValue } from "@arden-hq/protocol"
import type {
  AutomationEventType,
  AutomationToolScope,
  AutomationTrigger,
  AutomationTriggerContext,
  AutomationTriggerSpec,
  CountAutomationTrigger,
  EventAutomationTrigger,
  IdleAutomationTrigger,
  TimeSchedule
} from "@arden-hq/protocol/automations"
import { HOME_LETTER_AUTOMATION_REF } from "@arden-hq/protocol/automations"
import { Context, type Effect, Schema } from "effect"
import type { InternalLifecycleEvent } from "../sessions/internal-events.js"
import type { AutomationStoreError } from "./store.js"
import type { EffectTarget } from "../../execution/tool-effect.js"
import type { HandlerItemKind } from "./handler-item.js"

export const SYSTEM_HANDLER = {
  memoryCapture: "memory_capture",
  dailySummary: "daily_summary",
  homeLetter: "home_letter",
  managedHistoryCollection: "managed_history_collection",
  wikiMaintenance: "wiki_maintenance",
  chatSummaries: "chat_summaries",
  events: "events"
} as const
export type SystemHandlerId = (typeof SYSTEM_HANDLER)[keyof typeof SYSTEM_HANDLER]
const SYSTEM_HANDLER_IDS: ReadonlyArray<SystemHandlerId> = Object.values(SYSTEM_HANDLER)
export const SystemHandlerIdSchema = Schema.Literals(SYSTEM_HANDLER_IDS)
export const isSystemHandlerId = Schema.is(SystemHandlerIdSchema)

export const AutomationId = Schema.NonEmptyString.pipe(Schema.brand("AutomationId"))
export type AutomationId = typeof AutomationId.Type

export const HOME_LETTER_AUTOMATION_ID = AutomationId.make(HOME_LETTER_AUTOMATION_REF)
export const DAILY_SUMMARY_AUTOMATION_ID = AutomationId.make("builtin-daily-summary")
export const EVENTS_AUTOMATION_ID = AutomationId.make("builtin-urgent-events")

export type SystemPromptEdit = "owner" | "fixed"

export type SystemTriggerScope = "any" | "item_events"

export interface SystemAutomationSpec {
  readonly automationId: AutomationId
  readonly name: string
  readonly description: string
  readonly prompt: string
  readonly handler: SystemHandlerId
  readonly triggers: ReadonlyArray<AutomationTriggerSpec>
  readonly enabled: boolean
  readonly cooldownMinutes: number | null
  readonly toolScope: AutomationToolScope
  readonly contextMode: "fresh" | "fork"
  readonly chatSession: boolean
  readonly promptEdit: SystemPromptEdit
  readonly triggerScope: SystemTriggerScope
  readonly manualRun: boolean
  readonly rearmOnSeed: boolean
}

export interface PersonalAutomationTriggers {
  readonly triggers: ReadonlyArray<AutomationTrigger>
  readonly times: ReadonlyArray<TimeSchedule>
  readonly idle: IdleAutomationTrigger | null
  readonly count: CountAutomationTrigger | null
}

export const EVENT_TRIGGER_REFUSAL = {
  missingAppEvent:
    "An mcp.event trigger requires mcp_event: the app's server, one event it lists, and its arguments",
  misplacedAppEvent: (eventType: AutomationEventType): string =>
    `mcp_event belongs only to mcp.event triggers, not ${eventType}`
} as const

export class InvalidAutomationScheduleError extends Error {
  override readonly name = "InvalidAutomationScheduleError"
}

export interface AutomationTriggerEvent {
  readonly eventType: AutomationEventType
  readonly eventKey: string
  readonly producedBy: string | null
  readonly chainDepth: number
  readonly context: Readonly<Record<string, JsonValue>>
  readonly touches?: ObjectTouch
}

export interface ObjectTouch {
  readonly target: EffectTarget
  readonly changedAt: string
}

export interface QuietChat {
  readonly sessionId: string
  readonly publicRef: string
  readonly name: string | null
  readonly spaceName: string | null
  readonly messages: ReadonlyArray<{
    readonly seq: number
    readonly role: typeof ROLE.user | typeof ROLE.assistant
    readonly createdAt: string
    readonly text: string
  }>
}

export interface EndedAutomationRun {
  readonly attemptId: number
  readonly automationId: string
  readonly automationRef: string
  readonly name: string
  readonly purpose: "user_automation" | "system"
  readonly outcome: "finished" | "failed" | "needs_you"
  readonly text: string
  readonly chat: { readonly sessionId: string; readonly publicRef: string } | undefined
  readonly wokenBy: AutomationTriggerContext | undefined
}

export interface TaskFeedRow {
  readonly eventId: number
  readonly kind: string
  readonly summary: string
  readonly at: string
  readonly itemId: string
  readonly key: string
  readonly text: string
  readonly status: string
  readonly blocked: boolean
  readonly spaceId: string | undefined
  readonly spaceName: string | undefined
  readonly producedBy: string | undefined
  readonly chainDepth: number
}

export interface ConnectionItemFeedRow {
  readonly itemId: string
  readonly source: string
  readonly threadKey: string
  readonly title: string
  readonly sender: string | undefined
  readonly receivedAt: string
  readonly snippet: string
  readonly detail: Readonly<Record<string, JsonValue>> | undefined
}

export interface EventChat {
  readonly sessionId: string
  readonly publicRef: string
  readonly name: string | undefined
  readonly spaceName: string | undefined
}

export interface AskFeedRow {
  readonly kind: "question" | "approval" | "connection"
  readonly key: string
  readonly text: string
  readonly detail: string | undefined
  readonly toolName: string | undefined
  readonly askedAt: string
  readonly chat: EventChat | undefined
  readonly producedBy: string | undefined
  readonly automationName: string | undefined
  readonly chainDepth: number
}

export interface JournalRecord {
  readonly atMs: number
  readonly event: AutomationEvent | InternalLifecycleEvent
}

export type AskRef =
  | { readonly kind: "question"; readonly questionId: string }
  | { readonly kind: "card"; readonly runId: string; readonly toolCallId: string }

export interface JournalReads {
  readonly chat: (sessionId: string) => Effect.Effect<EventChat | undefined, AutomationStoreError>
  readonly taskHistory: (
    eventId: number
  ) => Effect.Effect<
    Omit<TaskFeedRow, "producedBy" | "chainDepth"> | undefined,
    AutomationStoreError
  >
  readonly openAsk: (ask: AskRef) => Effect.Effect<AskFeedRow | undefined, AutomationStoreError>
}

export interface RaisedEvent {
  readonly event: AutomationTriggerEvent
  readonly dueAt?: number
}

export const wikiChangedRevision = (event: AutomationTriggerEvent): string | null =>
  event.eventType === "wiki.changed" ? event.eventKey : null

export class AutomationRules extends Context.Service<
  AutomationRules,
  {
    readonly triggers: (triggers: ReadonlyArray<AutomationTrigger>) => PersonalAutomationTriggers
    readonly nextRunAt: (
      schedule: Pick<PersonalAutomationTriggers, "times">,
      afterMs: number
    ) => number | null
    readonly oneShot: (schedule: Pick<PersonalAutomationTriggers, "times">) => boolean
    readonly eventMatches: (
      trigger: EventAutomationTrigger,
      event: AutomationTriggerEvent
    ) => boolean
    readonly itemOwner: (kind: HandlerItemKind) => SystemHandlerId
    readonly systemSpec: (handler: string) => SystemAutomationSpec | undefined
    readonly chatQuietEvent: (chat: QuietChat) => AutomationTriggerEvent | undefined
    readonly runEndedEvent: (run: EndedAutomationRun) => AutomationTriggerEvent | undefined
    readonly connectionItemEvent: (row: ConnectionItemFeedRow) => AutomationTriggerEvent | undefined
    readonly fromJournal: (
      record: JournalRecord,
      read: JournalReads
    ) => Effect.Effect<ReadonlyArray<RaisedEvent>, AutomationStoreError>
  }
>()("@arden-hq/server/persistence/AutomationRules") {}
