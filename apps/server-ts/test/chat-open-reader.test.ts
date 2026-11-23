import type { ChatProjectionEvent } from "@arden-hq/protocol"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber, Layer, Ref, Schedule, Schema, Scope, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type * as Sse from "effect/unstable/encoding/Sse"
import { describe, expect, it } from "vitest"

import { automationRulesLayer } from "../src/automations/rules.js"
import { ChatEventStream } from "../src/chat/events.js"
import { ChatHistory } from "../src/chat/history.js"
import { chatRulesLayer } from "../src/chat/rules.js"
import { ChatEventStore } from "../src/persistence/events/store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { makeWriter } from "../src/persistence/sqlite/deps.js"
import { sqliteStoresOnWriter } from "../src/persistence/sqlite/layer.js"
import { sqliteWriterLayer } from "../src/persistence/sqlite/writer-client.js"
import { UnitOfWork } from "../src/persistence/unit-of-work.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"

const runId = "open-run"

const started = (sessionId: string) => ({
  event: {
    type: "RUN_STARTED",
    run_id: runId,
    session_id: sessionId,
    turn_id: "open-turn"
  } satisfies ChatProjectionEvent,
  runId
})

const messageStart = (messageId: string) => ({
  event: { type: "TEXT_MESSAGE_START", message_id: messageId } satisfies ChatProjectionEvent,
  runId
})

const delta = (messageId: string, text: string) => ({
  event: {
    type: "TEXT_MESSAGE_CONTENT",
    message_id: messageId,
    delta: text
  } satisfies ChatProjectionEvent,
  runId
})

const finished = {
  event: {
    type: "RUN_FINISHED",
    run_id: runId,
    turn_id: "open-turn"
  } satisfies ChatProjectionEvent,
  runId
}

const historyLayer = ChatHistory.layer({
  contextBudget: (input) =>
    Effect.succeed({
      model: input.model,
      hard_limit: null,
      compaction_trigger: null,
      input_tokens: input.inputTokens,
      message_count: input.messageCount
    })
})

const withChat = async <A, E>(
  body: Effect.Effect<
    A,
    E,
    | Scope.Scope
    | SqlClient.SqlClient
    | PersistenceWriteQueue
    | ChatEventStore
    | SessionStore
    | ChatEventStream
  >
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "arden-chat-open-"))
  const filename = join(directory, "arden.db")
  try {
    const persistence = sqliteStoresOnWriter({ dataDir: null, filename }).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          sqliteWriterLayer({ filename }),
          PersistenceWriteQueue.layer,
          automationRulesLayer,
          chatRulesLayer
        )
      )
    )
    const chat = ChatEventStream.layer.pipe(
      Layer.provideMerge(historyLayer),
      Layer.provideMerge(persistence)
    )
    return await Effect.runPromise(Effect.scoped(body).pipe(Effect.provide(chat)))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

type Seen =
  | {
      readonly kind: "snapshot"
      readonly applied: number
      readonly checkpoint: number
      readonly active: ReadonlyArray<number>
    }
  | { readonly kind: "record"; readonly sequence: number }
  | { readonly kind: "overflow"; readonly cursor: number }

const SnapshotData = Schema.fromJsonString(
  Schema.Struct({
    snapshot: Schema.Struct({
      applied_seq: Schema.Int,
      history: Schema.Struct({ runtime: Schema.Struct({ checkpoint_seq: Schema.Int }) }),
      active_events: Schema.Array(Schema.Struct({ seq: Schema.Int }))
    })
  })
)

const parse = (event: Sse.Event): Seen | undefined => {
  switch (event.event) {
    case "stream_live":
    case "stream_keepalive":
      return undefined
    case "stream_overflow":
      return { kind: "overflow", cursor: Number(event.id) }
    case "stream_snapshot": {
      const { snapshot } = Schema.decodeUnknownSync(SnapshotData)(event.data)
      return {
        kind: "snapshot",
        applied: snapshot.applied_seq,
        checkpoint: snapshot.history.runtime.checkpoint_seq,
        active: snapshot.active_events.map((active) => active.seq)
      }
    }
    default:
      return { kind: "record", sequence: Number(event.id) }
  }
}

const openChat = Effect.fn("test.openChat")(function* (sessionId: string) {
  const chat = yield* ChatEventStream
  const seen = yield* Ref.make<ReadonlyArray<Seen>>([])
  const { stream } = yield* chat.open({ sessionId })
  yield* stream.pipe(
    Stream.runForEach((event) =>
      Ref.update(seen, (current) => {
        const parsed = parse(event)
        return parsed === undefined ? current : [...current, parsed]
      })
    ),
    Effect.forkScoped
  )
  return seen
})

const delivered = (seen: Ref.Ref<ReadonlyArray<Seen>>, head: number) =>
  Ref.get(seen).pipe(
    Effect.flatMap((current) => {
      const snapshot = current.find((item) => item.kind === "snapshot")
      const overflow = current.find((item) => item.kind === "overflow")
      const tail = current.flatMap((item) => (item.kind === "record" ? [item.sequence] : []))
      if (overflow !== undefined) return Effect.succeed({ overflow, snapshot, tail })
      const reached = Math.max(snapshot?.applied ?? 0, ...tail) >= head
      return snapshot !== undefined && reached
        ? Effect.succeed({ overflow, snapshot, tail })
        : Effect.fail("not yet" as const)
    }),
    Effect.retry(Schedule.spaced("5 millis")),
    Effect.timeout("3 seconds")
  )

const sequencesThrough = (head: number) => Array.from({ length: head }, (_, index) => index + 1)

const transactLagged = Effect.fn("test.transactLagged")(function* <A, E>(
  work: Effect.Effect<A, E, UnitOfWork>,
  options: { readonly committed: Deferred.Deferred<void>; readonly lag: string }
) {
  const sql = yield* SqlClient.SqlClient
  const writer = makeWriter({ sql, reader: sql, queue: yield* PersistenceWriteQueue })
  return yield* writer.transact(
    Effect.gen(function* () {
      const unit = yield* UnitOfWork
      yield* unit.afterCommit(
        Deferred.succeed(options.committed, undefined).pipe(
          Effect.andThen(Effect.sleep(options.lag))
        )
      )
      return yield* work
    })
  )
})

describe("Chat open on a reader", () => {
  it("sends each sequence once across snapshot and tail while events commit", () =>
    withChat(
      Effect.gen(function* () {
        const events = yield* ChatEventStore
        const sessions = yield* SessionStore
        const batches = 8
        for (let round = 0; round < 30; round++) {
          const { sessionId } = yield* sessions.create({ name: `Interleaving ${round}` })
          yield* events.append({ sessionId, events: [started(sessionId)] })
          const appending = yield* Effect.forEach(
            Array.from({ length: batches }, (_, index) => index),
            (index) =>
              Effect.sleep(`${(round * 7 + index * 3) % 4} millis`).pipe(
                Effect.andThen(
                  events.append({
                    sessionId,
                    events: [messageStart(`m${index}`), delta(`m${index}`, `${index}`)]
                  })
                )
              ),
            { discard: true }
          ).pipe(Effect.forkScoped)
          yield* Effect.sleep(`${(round * 5) % 12} millis`)
          const seen = yield* openChat(sessionId)
          yield* Fiber.join(appending)
          const head = 1 + batches * 2
          const result = yield* delivered(seen, head)

          expect(result.overflow).toBeUndefined()
          expect(
            [...(result.snapshot?.active ?? []), ...result.tail].sort((a, b) => a - b)
          ).toEqual(sequencesThrough(head))
          expect(result.tail.every((sequence) => sequence > (result.snapshot?.applied ?? 0))).toBe(
            true
          )
        }
      })
    ))

  it("never loses a live-only record whose commit is not yet applied to the projection", () =>
    withChat(
      Effect.gen(function* () {
        const events = yield* ChatEventStore
        const sessions = yield* SessionStore
        for (const lag of ["30 millis", "300 millis"]) {
          const { sessionId } = yield* sessions.create({ name: `Publish lag ${lag}` })
          yield* events.append({ sessionId, events: [started(sessionId)] })
          const committed = yield* Deferred.make<void>()
          const appending = yield* transactLagged(
            events.appendInTransaction({ sessionId, events: [delta("m", "late")] }),
            { committed, lag }
          ).pipe(Effect.forkScoped)
          yield* Deferred.await(committed)
          const lagging = yield* events.activeProjection({
            sessionId,
            afterSequence: 0,
            throughSequence: 2
          })
          const seen = yield* openChat(sessionId)
          yield* Fiber.join(appending)
          const result = yield* delivered(seen, 2)

          expect(lagging).toMatchObject({ publishedThrough: 1 })
          expect(result.overflow).toBeUndefined()
          expect(
            [...(result.snapshot?.active ?? []), ...result.tail].sort((a, b) => a - b)
          ).toEqual([1, 2])
        }
      })
    ))
})
