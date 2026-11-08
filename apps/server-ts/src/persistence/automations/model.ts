import type { AutomationEvent, JsonValue } from "@arden-hq/protocol"
import type {
  AutomationEventType,
  AutomationToolScope,
  AutomationTrigger,
  AutomationTriggerContext,
  AutomationTriggerInput,
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

export const SYSTEM_HANDLER_IDS = [
  "memory_capture",
  "daily_summary",
  "home_letter",
  "managed_history_collection",
  "wiki_maintenance",
  "chat_summaries"
] as const
export type SystemHandlerId = (typeof SYSTEM_HANDLER_IDS)[number]

export const AutomationId = Schema.NonEmptyString.pipe(Schema.brand("AutomationId"))
export type AutomationId = typeof AutomationId.Type

export const HOME_LETTER_AUTOMATION_ID = AutomationId.make(HOME_LETTER_AUTOMATION_REF)

export interface SystemAutomationSpec {
  readonly automationId: AutomationId
  readonly name: string
  readonly description: string
  readonly prompt: string
  readonly handler: SystemHandlerId
  readonly triggers: ReadonlyArray<AutomationTrigger>
  readonly enabled: boolean
  readonly cooldownMinutes: number | null
  readonly toolScope: AutomationToolScope
  readonly contextMode: "fresh" | "fork"
  readonly chatSession: boolean
  readonly runsModel: boolean
  readonly manualRun: boolean
  readonly rearmOnSeed: boolean
}

export interface PersonalAutomationTriggers {
  readonly triggers: ReadonlyArray<AutomationTrigger>
  readonly times: ReadonlyArray<TimeSchedule>
  readonly idle: IdleAutomationTrigger | null
  readonly count: CountAutomationTrigger | null
}

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
    readonly role: "user" | "assistant"
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
    readonly triggers: (
      triggers: ReadonlyArray<AutomationTriggerInput | AutomationTrigger>
    ) => PersonalAutomationTriggers
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
