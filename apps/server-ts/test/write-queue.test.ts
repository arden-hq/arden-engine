import { Deferred, Effect, Fiber } from "effect"
import { expect, it } from "vitest"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"

it("runs an interactive snapshot before queued ordinary writes", async () => {
  const order = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const writes = yield* PersistenceWriteQueue
        const firstStarted = yield* Deferred.make<void>()
        const releaseFirst = yield* Deferred.make<void>()
        const order: string[] = []

        const first = yield* writes
          .run(
            Effect.gen(function* () {
              order.push("first")
              yield* Deferred.succeed(firstStarted, undefined)
              yield* Deferred.await(releaseFirst)
            })
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(firstStarted)
        const ordinary = yield* writes
          .run(Effect.sync(() => order.push("ordinary")))
          .pipe(Effect.forkChild)
        const interactive = yield* writes
          .runInteractive(Effect.sync(() => order.push("interactive")))
          .pipe(Effect.forkChild)

        yield* Deferred.succeed(releaseFirst, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(interactive)
        yield* Fiber.join(ordinary)
        return order
      }).pipe(Effect.provide(PersistenceWriteQueue.layer))
    )
  )

  expect(order).toEqual(["first", "interactive", "ordinary"])
})

it("gives ordinary work a turn before an interactive backlog drains", async () => {
  const order = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const writes = yield* PersistenceWriteQueue
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const order: string[] = []
        const first = yield* writes
          .run(Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))))
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)
        const ordinary = yield* writes
          .run(Effect.sync(() => order.push("ordinary")))
          .pipe(Effect.forkChild)
        const interactive = yield* Effect.forEach(
          Array.from({ length: 16 }, (_, index) => index),
          (index) =>
            writes
              .runInteractive(Effect.sync(() => order.push(`interactive-${index}`)))
              .pipe(Effect.forkChild)
        )
        yield* Effect.yieldNow
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(ordinary)
        yield* Effect.forEach(interactive, Fiber.join)
        return order
      }).pipe(Effect.provide(PersistenceWriteQueue.layer))
    )
  )
  expect(order[0]).toBe("interactive-0")
  expect(order.indexOf("ordinary")).toBeLessThan(order.length - 1)
  expect(order.filter((value) => value.startsWith("interactive-"))).toEqual(
    Array.from({ length: 16 }, (_, index) => `interactive-${index}`)
  )
})

it("lets a cancelled caller leave while its accepted write and publication still drain", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const writes = yield* PersistenceWriteQueue
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const committed: string[] = []
        const caller = yield* writes
          .run(
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(release)
              committed.push("commit", "publication")
            })
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* Fiber.interrupt(caller)
        const atCancellation = [...committed]
        yield* Deferred.succeed(release, undefined)
        yield* writes.flush
        return { atCancellation, committed }
      }).pipe(Effect.provide(PersistenceWriteQueue.layer))
    )
  )
  expect(result).toEqual({ atCancellation: [], committed: ["commit", "publication"] })
})
