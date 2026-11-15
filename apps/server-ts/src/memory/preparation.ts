import { Cause, DateTime, Effect, Fiber, Semaphore, type Scope } from "effect"

import type { Wiki } from "../wiki/service.js"
import { prepareMemorySearch } from "./retrieval.js"

interface MemoryPreparation {
  readonly schedule: () => Effect.Effect<void>
  readonly foreground: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export const makeMemoryPreparation = Effect.fn("MemoryPreparation.make")(function* (input: {
  readonly wiki: Pick<Wiki["Service"], "head" | "snapshot" | "prepareHistory">
}): Effect.fn.Return<MemoryPreparation, never, Scope.Scope> {
  const scope = yield* Effect.scope
  const serialize = (yield* Semaphore.make(1)).withPermit
  let preparedHead: string | null | undefined
  let pending: Fiber.Fiber<void> | undefined
  let foreground = 0

  const schedule = Effect.fn("MemoryPreparation.schedule")(function* () {
    if (pending !== undefined || foreground > 0) return
    pending = yield* Effect.forkIn(
      Effect.gen(function* () {
        yield* Effect.sleep("100 millis")
        const start = yield* DateTime.now
        yield* Effect.all(
          [
            Effect.gen(function* () {
              const head = yield* input.wiki.head()
              if (head === preparedHead) return
              const current = yield* input.wiki.snapshot()
              for (let offset = 0; offset < current.pages.length; offset += 8) {
                prepareMemorySearch(current.pages.slice(offset, offset + 8))
                yield* Effect.yieldNow
              }
              preparedHead = current.head
            }),
            input.wiki
              .prepareHistory()
              .pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.void
                    : Effect.logWarning("Memory history preparation unavailable", { cause })
                )
              )
          ],
          { concurrency: 2, discard: true }
        )
        const end = yield* DateTime.now
        yield* Effect.logInfo("Memory prepared before Send", {
          revision: preparedHead,
          durationMs: DateTime.toEpochMillis(end) - DateTime.toEpochMillis(start)
        })
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning("Memory preparation unavailable", { cause })
        ),
        Effect.ensuring(
          Effect.sync(() => {
            pending = undefined
          })
        )
      ),
      scope
    )
  }, serialize)

  const enter = serialize(
    Effect.gen(function* () {
      foreground += 1
      if (pending !== undefined) yield* Fiber.interrupt(pending)
    })
  )

  return {
    schedule,
    foreground: (effect) =>
      Effect.acquireUseRelease(
        enter,
        () => effect,
        () =>
          Effect.sync(() => {
            foreground -= 1
          })
      )
  }
})
