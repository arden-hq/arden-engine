import type {
  AutomationEventProducer,
  AutomationTriggerContext
} from "@arden-hq/protocol/automations"
import { AutomationEventProducerSchema } from "@arden-hq/protocol/effect/automations"
import type { BatchedEvent } from "./event-batch.js"

export type EventCause = Extract<AutomationTriggerContext, { readonly source: "event" }>

export const eventProducer = (producedBy: string | null): AutomationEventProducer =>
  producedBy === null ? { kind: "outside" } : { kind: "automation", automation_id: producedBy }

export const wakeCause = (
  producedBy: string | null,
  chainDepth: number
): Pick<EventCause, "produced_by" | "chain_depth"> => ({
  produced_by: eventProducer(producedBy),
  chain_depth: chainDepth
})

export const producerAutomationId = (producer: AutomationEventProducer): string | null =>
  AutomationEventProducerSchema.match(producer, {
    outside: () => null,
    automation: ({ automation_id }) => automation_id
  })

export const eventCauseOf = (event: BatchedEvent): EventCause => ({
  source: "event",
  queued_at: event.queued_at,
  event_type: event.event_type,
  event_key: event.event_key,
  produced_by: eventProducer(event.produced_by),
  chain_depth: event.chain_depth ?? 0,
  context: event.context
})

export const batchedEventOf = (cause: EventCause): BatchedEvent => ({
  event_type: cause.event_type,
  event_key: cause.event_key,
  queued_at: cause.queued_at,
  produced_by: producerAutomationId(cause.produced_by),
  ...(cause.chain_depth === 0 ? {} : { chain_depth: cause.chain_depth }),
  context: cause.context
})
