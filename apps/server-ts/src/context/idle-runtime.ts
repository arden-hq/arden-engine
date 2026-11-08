import { Clock, Effect, Layer, Stream } from "effect"
import { ModelProviderService } from "../models/provider.js"
import { SessionLifecycleEvents } from "../persistence/sessions/events.js"
import { ServerLifecycle } from "../runtime/lifecycle.js"
import { ContextCompaction } from "./service.js"

export const idleCompactionRuntime = ({
  enabled
}: {
  readonly enabled: boolean
}): Layer.Layer<never, never, ContextCompaction | ModelProviderService | SessionLifecycleEvents> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      if (!enabled) return
      const { idle } = yield* ContextCompaction
      const lifecycle = yield* ServerLifecycle
      const events = yield* SessionLifecycleEvents
      const provider = yield* ModelProviderService
      yield* lifecycle.background(
        Effect.gen(function* () {
          const follow = yield* events.open()
          const activity = follow.stream.pipe(
            Stream.runForEach((delivery) =>
              Effect.sync(() => {
                if (delivery.kind !== "record") {
                  idle.queue.clear("event stream gap")
                  return
                }
                const event = delivery.event
                if (event.type === "session_activity")
                  idle.queue.interrupt(event.session.session_id)
                if (event.type === "chat_input_committed")
                  idle.queue.cancel(event.chat_session_id, "owner wrote in the chat")
                if (event.type === "session_blocking_work" && event.blocking_work)
                  idle.queue.cancel(event.session_id, "chat has blocking work")
              })
            )
          )
          const worker = Effect.gen(function* () {
            while (true) {
              const candidate = idle.queue.take(yield* Clock.currentTimeMillis)
              if (candidate === undefined) {
                yield* Effect.sleep("15 seconds")
                continue
              }
              yield* Effect.acquireUseRelease(
                Effect.sync(() => idle.queue.start(candidate)),
                (controller) =>
                  idle.compact(candidate, controller.signal).pipe(Effect.timeout("2 minutes")),
                (controller) =>
                  Effect.sync(() => {
                    controller.abort()
                    idle.queue.finish(controller)
                  })
              ).pipe(
                Effect.catch((cause) =>
                  Effect.logDebug("Idle compaction skipped", {
                    sessionId: candidate.sessionId,
                    cause
                  })
                )
              )
            }
          })
          yield* Effect.all(
            [
              worker,
              activity,
              provider.changes.pipe(
                Stream.runForEach(() => Effect.sync(() => idle.queue.clear("model route changed")))
              )
            ],
            { concurrency: "unbounded", discard: true }
          )
        }).pipe(Effect.ensuring(Effect.sync(() => idle.queue.clear("server stopping"))))
      )
    })
  )
