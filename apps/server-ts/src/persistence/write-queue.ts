import { Clock, Context, Deferred, Effect, Layer, Option, Queue } from "effect"
import { Diagnostics } from "../runtime/diagnostics.js"

const WRITE_QUEUE_CAPACITY = 64
const INTERACTIVE_BURST = 8
const SLOW_WAIT_MS = 500

type Lane = "interactive" | "ordinary"

interface WriteRequest {
  readonly lane: Lane
  readonly operation: string
  readonly admittedAt: number
  readonly execute: Effect.Effect<void>
  readonly cancel: Effect.Effect<void>
}

export class PersistenceWriteQueue extends Context.Service<
  PersistenceWriteQueue,
  {
    readonly run: <A, E>(operation: Effect.Effect<A, E>) => Effect.Effect<A, E>
    readonly runInteractive: <A, E>(operation: Effect.Effect<A, E>) => Effect.Effect<A, E>
    readonly flush: Effect.Effect<void>
  }
>()("@arden-hq/server/persistence/PersistenceWriteQueue") {
  static readonly layer: Layer.Layer<PersistenceWriteQueue> = Layer.effect(
    PersistenceWriteQueue,
    Effect.gen(function* () {
      const diagnostics = yield* Diagnostics
      const queues = yield* Effect.acquireRelease(
        Effect.all({
          interactive: Queue.bounded<WriteRequest>(WRITE_QUEUE_CAPACITY),
          ordinary: Queue.bounded<WriteRequest>(WRITE_QUEUE_CAPACITY)
        }),
        Effect.fn("PersistenceWriteQueue.release")(function* (queues) {
          const pending = yield* Effect.all([
            Queue.clear(queues.interactive),
            Queue.clear(queues.ordinary)
          ]).pipe(Effect.map(([interactive, ordinary]) => [...interactive, ...ordinary]))
          yield* Effect.forEach(pending, (request) => request.cancel, { discard: true })
          yield* Effect.all([Queue.shutdown(queues.interactive), Queue.shutdown(queues.ordinary)])
        })
      )

      let previousOperation: string | null = null
      const reportSlowWait = Effect.fn("PersistenceWriteQueue.reportSlowWait")(function* (
        request: WriteRequest
      ) {
        const waitMs = (yield* Clock.currentTimeMillis) - request.admittedAt
        if (waitMs < SLOW_WAIT_MS) return
        const queued =
          (yield* Queue.size(queues.interactive)) + (yield* Queue.size(queues.ordinary))
        yield* diagnostics.operational({
          code: "storage.write_wait",
          severity: "warning",
          cause: null,
          lane: request.lane,
          operation: request.operation,
          previousOperation,
          waitMs: Math.round(waitMs),
          queued
        })
      })

      let interactiveStreak = 0
      const worker = Effect.forever(
        Effect.gen(function* () {
          const preferred =
            interactiveStreak >= INTERACTIVE_BURST ? queues.ordinary : queues.interactive
          const other = preferred === queues.ordinary ? queues.interactive : queues.ordinary
          const first = yield* Queue.poll(preferred)
          const available = Option.isSome(first) ? first : yield* Queue.poll(other)
          const request = Option.isSome(available)
            ? available.value
            : yield* Effect.race(Queue.take(queues.interactive), Queue.take(queues.ordinary))
          interactiveStreak =
            request.lane === "interactive" ? Math.min(interactiveStreak + 1, INTERACTIVE_BURST) : 0
          yield* reportSlowWait(request)
          const started = yield* Clock.currentTimeMillis
          yield* Effect.uninterruptible(request.execute)
          const durationMs = (yield* Clock.currentTimeMillis) - started
          if (durationMs >= SLOW_WAIT_MS) {
            yield* diagnostics.operational({
              code: "storage.write_slow",
              severity: "warning",
              cause: null,
              lane: request.lane,
              operation: request.operation,
              durationMs: Math.round(durationMs)
            })
          }
          previousOperation = request.operation
        })
      )
      yield* Effect.forkScoped(worker)

      const submit = <A, E>(lane: Lane, operation: Effect.Effect<A, E>): Effect.Effect<A, E> =>
        Effect.currentSpan.pipe(
          Effect.map((span) => span.name),
          Effect.orElseSucceed(() => "untraced"),
          Effect.flatMap((name) =>
            Effect.uninterruptibleMask(
              Effect.fn("PersistenceWriteQueue.submit")(function* (restore) {
                const result = yield* Deferred.make<A, E>()
                const request: WriteRequest = {
                  lane,
                  operation: name,
                  admittedAt: yield* Clock.currentTimeMillis,
                  execute: operation.pipe(
                    Effect.onExit((exit) => Deferred.done(result, exit)),
                    Effect.exit,
                    Effect.asVoid
                  ),
                  cancel: Deferred.interrupt(result).pipe(Effect.asVoid)
                }
                const accepted = yield* restore(Queue.offer(queues[lane], request))
                if (!accepted) {
                  return yield* Effect.interrupt
                }
                return yield* restore(Deferred.await(result))
              })
            )
          )
        )

      const flush = Effect.all(
        [submit("interactive", Effect.void), submit("ordinary", Effect.void)],
        { discard: true }
      )
      yield* Effect.addFinalizer(() => flush)
      return PersistenceWriteQueue.of({
        run: (operation) => submit("ordinary", operation),
        runInteractive: (operation) => submit("interactive", operation),
        flush
      })
    })
  )
}
