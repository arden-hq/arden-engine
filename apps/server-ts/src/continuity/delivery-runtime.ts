import { Effect, Layer } from "effect"
import {
  CommunicationStore,
  type CommunicationDelivery,
  type CommunicationStoreError
} from "../persistence/continuity/store.js"
import { serializeOperationalCause } from "../runtime/operational-events.js"
import { pollEverySecond, runOutbox, type Outbox } from "../runtime/outbox.js"

const communicationOutbox = (
  communication: CommunicationStore["Service"]
): Outbox<CommunicationDelivery, CommunicationStoreError, never> => ({
  name: "communication",
  pending: communication.pendingDeliveries(),
  deliver: communication.deliverEnvelope,
  defer: (delivery, cause) =>
    communication
      .deferDelivery(delivery, serializeOperationalCause(cause) ?? "Unknown delivery failure")
      .pipe(
        Effect.catchCause((deferCause) =>
          Effect.logWarning("Could not schedule Communication delivery retry", {
            deliveryId: delivery.deliveryId,
            cause: deferCause
          })
        )
      )
})

export const CommunicationDeliveryRuntime: Layer.Layer<never, never, CommunicationStore> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const communication = yield* CommunicationStore
      yield* Effect.forkScoped(runOutbox(communicationOutbox(communication), pollEverySecond))
    })
  )
