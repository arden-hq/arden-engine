import type { ChatProjectionEvent } from "@arden-hq/protocol"
import { Effect, Fiber, Stream } from "effect"
import { describe, expect, it } from "vitest"

import type { ContractBackend } from "./backend.js"

const renamed = (sessionId: string, name: string) => ({
  event: { type: "session_updated", session_id: sessionId, name } satisfies ChatProjectionEvent
})

const runId = "contract-run"

const started = (sessionId: string) => ({
  event: {
    type: "RUN_STARTED",
    run_id: runId,
    session_id: sessionId,
    turn_id: "contract-turn"
  } satisfies ChatProjectionEvent,
  runId
})

const delta = (text: string) => ({
  event: {
    type: "TEXT_MESSAGE_CONTENT",
    message_id: "contract-message",
    delta: text
  } satisfies ChatProjectionEvent,
  runId
})

export const chatEventStoreContract = (backend: ContractBackend) =>
  describe(`ChatEventStore contract (${backend.name})`, () => {
    it("appends a batch in its own unit of work and reads it back from the head", () =>
      backend.run(({ sessions, chatEvents }) =>
        Effect.gen(function* () {
          const { sessionId } = yield* sessions.create({ name: "Chat contract" })
          const before = yield* chatEvents.watermarks(sessionId)
          const committed = yield* chatEvents.append({
            sessionId,
            events: [renamed(sessionId, "First")]
          })
          const after = yield* chatEvents.watermarks(sessionId)
          const page = yield* chatEvents.readPage({
            sessionId,
            afterSequence: before.headSequence,
            throughSequence: after.headSequence,
            limit: 10
          })

          expect(committed.headSequence).toBe(before.headSequence + 1)
          expect(after.headSequence).toBe(committed.headSequence)
          expect(page).toEqual({ records: committed.records, hasMore: false })
        })
      ))

    it("publishes a batch only after the unit of work commits", () =>
      backend.run(({ sessions, chatEvents, transact }) =>
        Effect.gen(function* () {
          const { sessionId } = yield* sessions.create({ name: "Chat publish" })
          yield* chatEvents.append({ sessionId, events: [started(sessionId)] })
          const follow = yield* chatEvents.openFollow({ sessionId, startAt: "latest" })
          const next = yield* follow.stream.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped
          )
          const { committed, pendingInside } = yield* transact(
            Effect.gen(function* () {
              const appended = yield* chatEvents.appendInTransaction({
                sessionId,
                events: [delta("live")]
              })
              yield* Effect.sleep("20 millis")
              return {
                committed: appended,
                pendingInside: yield* Effect.sync(() => next.pollUnsafe())
              }
            })
          )
          const [delivered] = yield* Fiber.join(next)

          expect(pendingInside).toBeUndefined()
          expect(delivered).toEqual({
            kind: "record",
            record: committed.records[0],
            replayed: false
          })
        })
      ))

    it("commits a batch and its checkpoint together", () =>
      backend.run(({ sessions, chatEvents, transact }) =>
        Effect.gen(function* () {
          const { sessionId } = yield* sessions.create({ name: "Chat checkpoint" })
          const committed = yield* transact(
            Effect.gen(function* () {
              const appended = yield* chatEvents.appendInTransaction({
                sessionId,
                events: [renamed(sessionId, "Checkpointed")]
              })
              yield* chatEvents.setCheckpointInTransaction(sessionId, appended.headSequence)
              return appended
            })
          )

          expect(yield* chatEvents.watermarks(sessionId)).toMatchObject({
            headSequence: committed.headSequence,
            checkpointSequence: committed.headSequence
          })
        })
      ))

    it("leaves no trace of a unit of work that fails", () =>
      backend.run(({ sessions, chatEvents, transact }) =>
        Effect.gen(function* () {
          const { sessionId } = yield* sessions.create({ name: "Chat rollback" })
          yield* chatEvents.append({ sessionId, events: [started(sessionId)] })
          const before = yield* chatEvents.watermarks(sessionId)
          const follow = yield* chatEvents.openFollow({ sessionId, startAt: "latest" })
          const failure = yield* Effect.flip(
            transact(
              chatEvents
                .appendInTransaction({
                  sessionId,
                  events: [renamed(sessionId, "Lost"), delta("lost")]
                })
                .pipe(Effect.andThen(Effect.fail("abandon the unit")))
            )
          )
          const afterFailure = yield* chatEvents.watermarks(sessionId)
          const kept = yield* chatEvents.append({ sessionId, events: [delta("kept")] })
          const [delivered] = yield* follow.stream.pipe(Stream.take(1), Stream.runCollect)

          expect(failure).toBe("abandon the unit")
          expect(afterFailure).toEqual(before)
          expect(delivered).toEqual({ kind: "record", record: kept.records[0], replayed: false })
        })
      ))

    it("refuses a checkpoint beyond the head", () =>
      backend.run(({ sessions, chatEvents, transact }) =>
        Effect.gen(function* () {
          const { sessionId } = yield* sessions.create({ name: "Chat head" })
          const marks = yield* chatEvents.watermarks(sessionId)
          const refused = yield* Effect.flip(
            transact(chatEvents.setCheckpointInTransaction(sessionId, marks.headSequence + 1))
          )

          expect(refused).toMatchObject({ _tag: "ChatEventStoreError", operation: "checkpoint" })
          expect(yield* chatEvents.watermarks(sessionId)).toEqual(marks)
        })
      ))
  })
