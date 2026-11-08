import { Context, type Effect } from "effect"
import type { AutomationEventType, EventAutomationTrigger } from "@arden-hq/protocol/automations"
import type { AutomationTriggerEvent, JournalRecord } from "./model.js"
import type { AutomationStoreError } from "./store.js"

export const feedsActivityTriggers = (session: {
  readonly sessionType: string
  readonly originAutomationId: string | null
}): boolean => session.sessionType === "chat" && session.originAutomationId === null

export interface TriggerFeedRecord {
  readonly sequence: number
  readonly atMs: number
  readonly kind: "input_committed" | "activity" | "run_completed" | "other"
  readonly sessionId: string | null
  readonly journal: JournalRecord | undefined
}

export interface SourceCursorRef {
  readonly eventType: AutomationEventType
  readonly source: string
}

export interface AutomationEventDispatchOutcome {
  readonly queued: number
}

export class AutomationTriggers extends Context.Service<
  AutomationTriggers,
  {
    readonly triggerCursor: () => Effect.Effect<
      {
        readonly afterSequence: number
        readonly head: number
      },
      AutomationStoreError
    >
    readonly applyTriggerFeedRecord: (
      record: TriggerFeedRecord
    ) => Effect.Effect<void, AutomationStoreError>
    readonly dispatchEvent: (
      event: AutomationTriggerEvent
    ) => Effect.Effect<AutomationEventDispatchOutcome, AutomationStoreError>
    readonly publishConnectionItems: () => Effect.Effect<
      AutomationEventDispatchOutcome,
      AutomationStoreError
    >
    readonly readSourceCursor: (
      ref: SourceCursorRef
    ) => Effect.Effect<string | undefined, AutomationStoreError>
    readonly publishSourceEvents: (
      input: SourceCursorRef & {
        readonly events: ReadonlyArray<AutomationTriggerEvent>
        readonly cursor: string | undefined
      }
    ) => Effect.Effect<AutomationEventDispatchOutcome, AutomationStoreError>
    readonly releaseSourceCursors: (
      eventType: AutomationEventType,
      options?: { readonly keep: ReadonlyArray<string> }
    ) => Effect.Effect<void, AutomationStoreError>
    readonly listeningEventTriggers: () => Effect.Effect<
      ReadonlyArray<EventAutomationTrigger>,
      AutomationStoreError
    >
    readonly rearmIdleTriggers: () => Effect.Effect<void, AutomationStoreError>
  }
>()("@arden-hq/server/persistence/automations/AutomationTriggers") {}
