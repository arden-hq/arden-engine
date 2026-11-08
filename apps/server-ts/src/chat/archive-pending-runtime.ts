import { Effect, Layer, Stream } from "effect"
import {
  SessionLifecycleEvents,
  type SessionLifecycleDelivery
} from "../persistence/sessions/events.js"
import { ServerLifecycle } from "../runtime/lifecycle.js"
import { ChatStop } from "./chat-stop.js"

const endsWork = (delivery: SessionLifecycleDelivery): boolean => {
  if (delivery.kind === "reset") return true
  const event = delivery.event
  return (
    event.type === "run_settled" || (event.type === "session_blocking_work" && !event.blocking_work)
  )
}

export const ArchivePendingRuntime: Layer.Layer<never, never, ChatStop | SessionLifecycleEvents> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const stop = yield* ChatStop
      const events = yield* SessionLifecycleEvents
      const lifecycle = yield* ServerLifecycle
      const archive = stop
        .archivePending()
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not read the chats waiting to archive", { cause })
          )
        )
      yield* lifecycle.background(
        Effect.gen(function* () {
          const follow = yield* events.open()
          yield* archive
          yield* follow.stream.pipe(
            Stream.filter(endsWork),
            Stream.runForEach(() => archive)
          )
        })
      )
    })
  )
