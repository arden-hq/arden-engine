import { Effect, Layer } from "effect"
import {
  CommunicationStore,
  type CommunicationDelivery,
  type CommunicationStoreError
} from "../persistence/continuity/store.js"
import { PostStore, type PostDelivery, type PostStoreError } from "../persistence/posts/store.js"
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

const postOutbox = (posts: PostStore["Service"]): Outbox<PostDelivery, PostStoreError, never> => ({
  name: "posts",
  pending: posts.pendingDeliveries(),
  deliver: posts.deliver,
  defer: (delivery, cause) =>
    posts.defer(delivery, serializeOperationalCause(cause) ?? "Unknown delivery failure").pipe(
      Effect.catchCause((deferCause) =>
        Effect.logWarning("Could not schedule post delivery retry", {
          deliveryId: delivery.deliveryId,
          cause: deferCause
        })
      )
    )
})

export const CommunicationDeliveryRuntime: Layer.Layer<
  never,
  never,
  CommunicationStore | PostStore
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const communication = yield* CommunicationStore
    const posts = yield* PostStore
    yield* Effect.forkScoped(runOutbox(communicationOutbox(communication), pollEverySecond))
    yield* Effect.forkScoped(runOutbox(postOutbox(posts), pollEverySecond))
  })
)
