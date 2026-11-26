import type { ChatSendReceipt } from "../persistence/chat/send-contracts.js"
import { Effect } from "effect"
import { type ChatMessageFailure } from "./message-errors.js"
import { type ChatSendInput } from "./message-input.js"

export const makeDeliverBootArrivals = ({
  boot,
  send
}: {
  readonly boot: {
    readonly arrivals?: () => ReadonlyArray<ChatSendInput>
    readonly acknowledgeArrival?: (arrival: ChatSendInput) => void
  }
  readonly send: (input: ChatSendInput) => Effect.Effect<ChatSendReceipt, ChatMessageFailure>
}): Effect.Effect<void> => {
  const pendingBootArrivals = new Map(
    (boot.arrivals?.() ?? []).map((arrival) => [
      JSON.stringify([arrival.sessionId, arrival.clientId]),
      arrival
    ])
  )
  const deliverBootArrivals = Effect.gen(function* () {
    for (const arrival of pendingBootArrivals.values()) {
      yield* send(arrival).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            boot.acknowledgeArrival?.(arrival)
            pendingBootArrivals.delete(JSON.stringify([arrival.sessionId, arrival.clientId]))
          })
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not deliver a message left by the last shutdown", {
            sessionId: arrival.sessionId,
            cause
          })
        )
      )
    }
  })
  return deliverBootArrivals
}
