import { Effect, Fiber, Stream } from "effect"
import { describe, expect, it } from "vitest"

import type { SessionLifecycleDelivery } from "../../src/persistence/sessions/events.js"
import type { ContractBackend } from "./backend.js"

const recordOf = (delivery: SessionLifecycleDelivery) => {
  if (delivery.kind !== "record")
    throw new Error(`Expected a record, got a ${delivery.reason} reset`)
  return delivery
}

export const sessionLifecycleEventsContract = (backend: ContractBackend) =>
  describe(`SessionLifecycleEvents contract (${backend.name})`, () => {
    it("wakes followers only after the unit of work commits", () =>
      backend.run(({ sessions, sessionEvents, transact }) =>
        Effect.gen(function* () {
          const session = yield* sessions.create({ name: "Lifecycle contract" })
          const opened = yield* sessionEvents.open()
          const next = yield* opened.stream.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped
          )
          const pendingInside = yield* transact(
            Effect.gen(function* () {
              yield* sessionEvents.appendInTransaction("session_activity", session.sessionId)
              yield* Effect.sleep("20 millis")
              return yield* Effect.sync(() => next.pollUnsafe())
            })
          )
          const [delivered] = yield* Fiber.join(next)

          expect(pendingInside).toBeUndefined()
          expect(delivered === undefined ? undefined : recordOf(delivered)).toMatchObject({
            kind: "record",
            sequence: opened.initialSequence + 1,
            event: { type: "session_activity", session: { session_id: session.sessionId } },
            replayed: false
          })
        })
      ))

    it("leaves no trace of a unit of work that fails", () =>
      backend.run(({ sessions, sessionEvents, transact }) =>
        Effect.gen(function* () {
          const session = yield* sessions.create({ name: "Rolled back" })
          const opened = yield* sessionEvents.open()
          const failure = yield* Effect.flip(
            transact(
              sessionEvents
                .appendInTransaction("session_activity", session.sessionId)
                .pipe(Effect.andThen(Effect.fail("abandon the unit")))
            )
          )
          yield* transact(
            sessionEvents.appendEventInTransaction({
              type: "automation_progress",
              task_id: "contract-task",
              status: "after rollback"
            })
          )
          const [delivered] = yield* opened.stream.pipe(Stream.take(1), Stream.runCollect)

          expect(failure).toBe("abandon the unit")
          expect(delivered === undefined ? undefined : recordOf(delivered)).toMatchObject({
            sequence: opened.initialSequence + 1,
            event: { type: "automation_progress", status: "after rollback" }
          })
        })
      ))

    it("commits a navigation request in its own unit of work and replays it after a cursor", () =>
      backend.run(({ sessions, sessionEvents }) =>
        Effect.gen(function* () {
          const origin = yield* sessions.create({ name: "Navigation origin" })
          const before = yield* sessionEvents.open()
          const committed = yield* sessionEvents.appendEvent({
            type: "navigation_requested",
            origin_session_id: origin.sessionId,
            destination: { kind: "home" },
            label: "Home"
          })
          const [live] = yield* before.stream.pipe(Stream.take(1), Stream.runCollect)
          const replay = yield* sessionEvents.open(before.initialSequence)
          const [replayed] = yield* replay.stream.pipe(Stream.take(1), Stream.runCollect)

          expect(committed.headSequence).toBe(before.initialSequence + 1)
          expect(live === undefined ? undefined : recordOf(live)).toMatchObject({
            sequence: committed.headSequence,
            event: { type: "navigation_requested" },
            replayed: false
          })
          expect(replayed === undefined ? undefined : recordOf(replayed)).toMatchObject({
            sequence: committed.headSequence,
            event: { type: "navigation_requested" },
            replayed: true
          })
        })
      ))
  })
