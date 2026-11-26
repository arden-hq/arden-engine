import { timerSleep } from "../lib/timer-sleep.js"
import { Effect, Layer } from "effect"

import type { AutomationEventType } from "@arden-hq/protocol/automations"
import { AutomationTriggers } from "../persistence/automations/triggers.js"
import {
  AUTOMATION_EVENT_SOURCE,
  type AutomationEventProducer,
  type AutomationEventProducerServices
} from "./event-producer.js"
import { automationEventProducers } from "./event-producers.js"

const pollAutomationEventProducer = Effect.fn("AutomationEventProducers.poll")(function* <
  R extends AutomationEventProducerServices
>(producer: AutomationEventProducer<AutomationEventType, R>) {
  const source = producer.source
  switch (source.kind) {
    case AUTOMATION_EVENT_SOURCE.always:
      return yield* source.poll
    case AUTOMATION_EVENT_SOURCE.onDemand: {
      const triggers = yield* AutomationTriggers
      const [first, ...rest] = (yield* triggers.listeningEventTriggers()).filter(
        (trigger) => trigger.event_type === producer.eventType
      )
      if (first === undefined) {
        return yield* triggers.releaseSourceCursors(producer.eventType)
      }
      return yield* source.poll([first, ...rest])
    }
    case AUTOMATION_EVENT_SOURCE.live: {
      const triggers = yield* AutomationTriggers
      const listening = (yield* triggers.listeningEventTriggers()).filter(
        (trigger) => trigger.event_type === producer.eventType
      )
      const keep = yield* source.follow(listening)
      return yield* triggers.releaseSourceCursors(producer.eventType, { keep })
    }
    case AUTOMATION_EVENT_SOURCE.feed:
      return
  }
})

const pollInterval = (producer: AutomationEventProducer) =>
  producer.source.kind === AUTOMATION_EVENT_SOURCE.live ? "10 seconds" : "1 minute"

export const AutomationTriggerProducersRuntime: Layer.Layer<
  never,
  never,
  AutomationEventProducerServices
> = Layer.effectDiscard(
  Effect.gen(function* () {
    for (const producer of automationEventProducers) {
      if (producer.source.kind === AUTOMATION_EVENT_SOURCE.feed) continue
      yield* Effect.forkScoped(
        pollAutomationEventProducer(producer).pipe(
          Effect.catchCause((cause) => Effect.logWarning(producer.failureMessage, cause)),
          Effect.andThen(timerSleep(pollInterval(producer))),
          Effect.forever
        )
      )
    }
  })
)
