import type { AutomationEventType, EventAutomationTrigger } from "@arden-hq/protocol/automations"
import type { GoogleAccount } from "@arden-hq/protocol/google"
import type { Cause, Effect } from "effect"

import type { McpServer } from "@arden-hq/protocol/mcp"
import type { GoogleConnections } from "../google/service.js"
import type { McpEvents } from "../mcp/events/subscriptions.js"
import type {
  AutomationTriggerEvent,
  JournalReads,
  JournalRecord,
  RaisedEvent
} from "../persistence/automations/model.js"
import type { AutomationStoreError } from "../persistence/automations/store.js"
import type { AutomationTriggers } from "../persistence/automations/triggers.js"
import type { WikiEmbeddingIndex } from "../embedding/wiki-index.js"
import type { Wiki } from "../wiki/service.js"

export type AutomationEventProducerServices =
  | AutomationTriggers
  | GoogleConnections
  | McpEvents
  | Wiki
  | WikiEmbeddingIndex

interface AutomationEventAvailability {
  readonly googleAccounts: ReadonlyArray<GoogleAccount>
  readonly mcpServers: ReadonlyArray<McpServer>
}

type ProducerPoll<R> = Effect.Effect<unknown, Cause.YieldableError, R>

export const AUTOMATION_EVENT_SOURCE = {
  always: "always",
  onDemand: "on_demand",
  live: "live",
  feed: "feed"
} as const

type AutomationEventSource<R> =
  | { readonly kind: typeof AUTOMATION_EVENT_SOURCE.always; readonly poll: ProducerPoll<R> }
  | {
      readonly kind: typeof AUTOMATION_EVENT_SOURCE.onDemand
      readonly poll: (
        triggers: readonly [EventAutomationTrigger, ...Array<EventAutomationTrigger>]
      ) => ProducerPoll<R>
    }
  | {
      readonly kind: typeof AUTOMATION_EVENT_SOURCE.live
      readonly follow: (
        triggers: ReadonlyArray<EventAutomationTrigger>
      ) => Effect.Effect<ReadonlyArray<string>, Cause.YieldableError, R>
    }
  | { readonly kind: typeof AUTOMATION_EVENT_SOURCE.feed }

export interface AutomationEventProducer<
  T extends AutomationEventType = AutomationEventType,
  R extends AutomationEventProducerServices = AutomationEventProducerServices
> {
  readonly eventType: T
  readonly available?: (context: AutomationEventAvailability) => boolean
  readonly accepts?: (trigger: EventAutomationTrigger, event: AutomationTriggerEvent) => boolean
  readonly source: AutomationEventSource<R>
  readonly fromJournal?: (
    record: JournalRecord,
    read: JournalReads
  ) => Effect.Effect<ReadonlyArray<RaisedEvent>, AutomationStoreError>
  readonly failureMessage: string
}
