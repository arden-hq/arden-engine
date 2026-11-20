import { INTERACTION_KIND, INTERACTION_SOURCE } from "@arden-hq/std/message-vocabulary"
import { timerSleep } from "../lib/timer-sleep.js"
import { Cause, Effect, Exit, Layer } from "effect"
import { arrivalBatches } from "./arrival-batches.js"
import type { InteractionSender } from "@arden-hq/protocol/chat"
import type { ChatSendInput } from "../chat/message-input.js"
import { ChatMessage } from "../chat/message.js"
import type { RunDelivery } from "../persistence/deliveries/model.js"
import { WorkStore, type WorkStoreError } from "../persistence/work/store.js"
import { serializeOperationalCause } from "../runtime/operational-events.js"
import { pollEverySecond, runOutbox, type Outbox } from "../runtime/outbox.js"

const arrivalSender = (delivery: RunDelivery): InteractionSender | undefined => {
  if (delivery.interaction !== undefined) {
    const { content, ...sender } = delivery.interaction
    return content === delivery.body || sender.preview !== undefined
      ? sender
      : { ...sender, preview: delivery.body }
  }
  const { payload } = delivery
  const personsAnswer =
    payload.kind === "answer" && payload.timeout !== true && payload.questionId !== null
  if (personsAnswer || delivery.forwardedFrom !== undefined) return undefined
  return {
    kind: INTERACTION_KIND.event,
    from: { source: INTERACTION_SOURCE.harness, id: payload.kind }
  }
}

const toSendInput = (delivery: RunDelivery): ChatSendInput => {
  const sender = arrivalSender(delivery)
  return {
    sessionId: delivery.payload.sessionId,
    clientId: `arrival:${delivery.deliveryId}`,
    deliveryId: delivery.deliveryId,
    message: delivery.interaction?.content ?? delivery.body,
    ...(sender === undefined ? {} : { sender }),
    ...(delivery.forwardedFrom === undefined ? {} : { forwardedFrom: delivery.forwardedFrom }),
    ...(delivery.payload.kind === "answer" &&
    delivery.payload.timeout !== true &&
    delivery.payload.questionId !== null
      ? { questionAnswer: { questionId: delivery.payload.questionId } }
      : {}),
    ...(delivery.payload.kind === "connection" ? { connection: delivery.payload.connection } : {}),
    ...(delivery.payload.kind === "update" ? { update: delivery.payload.update } : {}),
    ...(delivery.images === undefined || delivery.images.length === 0
      ? {}
      : { images: delivery.images })
  }
}

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
          Effect.andThen(timerSleep(pollEverySecond.first)),
          Effect.forever
        )
      )
    })
  )
