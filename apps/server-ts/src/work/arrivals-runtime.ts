import { Cause, Effect, Exit, Layer } from "effect"
import { arrivalBatches } from "./arrival-batches.js"
import type { ChatSendInput } from "../chat/message-input.js"
import { ChatMessage } from "../chat/message.js"
import type { RunDelivery } from "../persistence/deliveries/model.js"
import { WorkStore, type WorkStoreError } from "../persistence/work/store.js"
import { serializeOperationalCause } from "../runtime/operational-events.js"
import { pollEverySecond, runOutbox, type Outbox } from "../runtime/outbox.js"

const toSendInput = (delivery: RunDelivery): ChatSendInput => ({
  sessionId: delivery.payload.sessionId,
  clientId: `arrival:${delivery.deliveryId}`,
  deliveryId: delivery.deliveryId,
  message: delivery.body,
  isMeta: true,
  ...(delivery.forwardedFrom === undefined ? {} : { forwardedFrom: delivery.forwardedFrom }),
  ...(delivery.payload.kind === "answer" &&
  delivery.payload.timeout !== true &&
  delivery.payload.questionId !== null
    ? { questionAnswer: { questionId: delivery.payload.questionId } }
    : {}),
  ...(delivery.payload.kind === "connection" ? { connection: delivery.payload.connection } : {}),
  ...(delivery.payload.kind === "update" ? { update: delivery.payload.update } : {}),
  ...(delivery.interaction === undefined ? {} : { interaction: delivery.interaction }),
  ...(delivery.images === undefined || delivery.images.length === 0
    ? {}
    : { images: delivery.images })
})

const deferDelivery = (
  work: WorkStore["Service"],
  delivery: RunDelivery,
  cause: Cause.Cause<unknown>
) =>
  work
    .deferDelivery(
      delivery.deliveryId,
      serializeOperationalCause(cause) ?? "Unknown delivery failure"
    )
    .pipe(
      Effect.catchCause((deferCause) =>
        Effect.logWarning("Could not schedule Run arrival retry", {
          deliveryId: delivery.deliveryId,
          cause: deferCause
        })
      ),
      Effect.andThen(
        Effect.logWarning("Run arrival remains pending", {
          deliveryId: delivery.deliveryId,
          cause
        })
      )
    )

const workArrivals = (
  work: WorkStore["Service"],
  chat: ChatMessage["Service"]
): Outbox<ReadonlyArray<RunDelivery>, WorkStoreError, never> => ({
  name: "work_arrivals",
  pending: work.pendingDeliveries().pipe(Effect.map(arrivalBatches)),
  deliver: (group) =>
    chat.sendTogether(group.map(toSendInput)).pipe(
      Effect.flatMap((exits) =>
        Effect.forEach(group, (delivery, index) => {
          const exit = exits[index]
          if (exit === undefined || Exit.isFailure(exit))
            return deferDelivery(work, delivery, exit?.cause ?? Cause.die("No receipt")).pipe(
              Effect.as(false)
            )
          const runId = exit.value.runId
          return runId === null
            ? Effect.succeed(false)
            : work.acknowledgeDelivery(delivery.deliveryId, runId).pipe(
                Effect.as(true),
                Effect.catchCause((cause) =>
                  deferDelivery(work, delivery, cause).pipe(Effect.as(false))
                )
              )
        })
      ),
      Effect.map((delivered) => delivered.some(Boolean))
    ),
  defer: (group, cause) =>
    Effect.forEach(group, (delivery) => deferDelivery(work, delivery, cause), { discard: true })
})

const cancelRevokedRuns = Effect.fn("WorkArrivals.cancelRevoked")(function* (
  work: WorkStore["Service"],
  chat: ChatMessage["Service"]
) {
  yield* work
    .expireQuestions()
    .pipe(
      Effect.catchCause((cause) => Effect.logWarning("Could not expire question timers", cause))
    )
  const revoked = yield* work.revokedRuns()
  yield* Effect.forEach(revoked, (run) =>
    chat
      .cancel({ runId: run.runId })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not cancel revoked Task attempt", { runId: run.runId, cause })
        )
      )
  )
})

export const WorkArrivalsRuntime: Layer.Layer<never, never, WorkStore | ChatMessage> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const work = yield* WorkStore
      const chat = yield* ChatMessage
      yield* Effect.forkScoped(runOutbox(workArrivals(work, chat), pollEverySecond))
      yield* Effect.forkScoped(
        cancelRevokedRuns(work, chat).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not inspect revoked Task attempts", cause)
          ),
          Effect.andThen(Effect.sleep(pollEverySecond.first)),
          Effect.forever
        )
      )
    })
  )
