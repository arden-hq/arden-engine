import type { ChatProjectionEvent } from "@arden-hq/protocol"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Ref,
  Schedule,
  Schema,
  Scope,
  Stream
} from "effect"
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

interface ArmedGate {
  readonly reached: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
}

/** Counts history reads; once armed, the next one waits after reading, so the
 * test can commit while a chat open holds its transaction's commit point. */
class OpenGate extends Context.Service<
  OpenGate,
  { readonly armed: Ref.Ref<ArmedGate | undefined>; readonly reads: Ref.Ref<number> }
>()("test/OpenGate") {
  static readonly layer = Layer.effect(
    OpenGate,
    Effect.all({ armed: Ref.make<ArmedGate | undefined>(undefined), reads: Ref.make(0) })
  )
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

/** The real ChatHistory, with a gate after its database read. */
const gatedHistoryLayer = Layer.effect(
  ChatHistory,
  Effect.gen(function* () {
    const history = yield* ChatHistory
    const gate = yield* OpenGate
    return ChatHistory.of({
      ...history,
      read: (input) =>
        history.read(input).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              yield* Ref.update(gate.reads, (n) => n + 1)
              const armed = yield* Ref.getAndSet(gate.armed, undefined)
              if (armed === undefined) return
              yield* Deferred.succeed(armed.reached, undefined)
              yield* Deferred.await(armed.release)
            })
          )
        )
    })
  })
).pipe(Layer.provide(historyLayer))

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
    | OpenGate
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
      Layer.provideMerge(gatedHistoryLayer),
      Layer.provideMerge(OpenGate.layer),
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

/** Opens the chat and collects what it sends, in the background. */
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

/** Waits until the chat has sent every sequence through `head`, then
 * returns the snapshot and the tail sequences. */
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
      // Runs after COMMIT and before the event store's own after-commit
      // publish, which the work registers next.
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
  it("returns its snapshot within a second while a write transaction holds the writer", () =>
    withChat(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const writes = yield* PersistenceWriteQueue
        const events = yield* ChatEventStore
        const { sessionId } = yield* (yield* SessionStore).create({ name: "Held writer" })
        yield* events.append({ sessionId, events: [started(sessionId)] })
        yield* events.append({ sessionId, events: [delta("m", "hello")] })

        const held = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const writing = yield* writes
          .run(
            sql.withTransaction(
              sql`UPDATE sessions SET name = 'Held' WHERE session_id = ${sessionId}`.pipe(
                Effect.andThen(Deferred.succeed(held, undefined)),
                Effect.andThen(Deferred.await(release))
              )
            )
          )
          .pipe(Effect.forkScoped)
        yield* Deferred.await(held)

        // Any statement on the writer during the open waits for `release`.
        const first = yield* Effect.gen(function* () {
          const chat = yield* ChatEventStream
          const { stream } = yield* chat.open({ sessionId })
          return yield* stream.pipe(Stream.take(1), Stream.runCollect)
        }).pipe(Effect.timeout("1 second"), Effect.ensuring(Deferred.succeed(release, undefined)))
        yield* Fiber.join(writing)

        expect(first.map(parse)).toEqual([
          { kind: "snapshot", applied: 2, checkpoint: 0, active: [1, 2] }
        ])
      })
    ))

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
        // 30 ms is within the open's retries; 300 ms outlasts them, and the
        // open falls back to the write queue.
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

  it("retries an open whose run ended after its transaction began, and leaves no hole", () =>
    withChat(
      Effect.gen(function* () {
        const events = yield* ChatEventStore
        const sessions = yield* SessionStore
        const gate = yield* OpenGate
        const { sessionId } = yield* sessions.create({ name: "Terminal trim" })
        yield* events.append({ sessionId, events: [started(sessionId)] })
        for (const text of ["a", "b", "c"]) {
          yield* events.append({ sessionId, events: [delta("m", text)] })
        }

        const reached = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        yield* Ref.set(gate.armed, { reached, release })
        yield* Ref.set(gate.reads, 0)
        const opening = yield* openChat(sessionId).pipe(Effect.forkScoped)
        yield* Deferred.await(reached)
        // The open's transaction saw head 4 and checkpoint 0. The run ends now
        // and the projection drops its deltas for the new checkpoint.
        const sql = yield* SqlClient.SqlClient
        const writer = makeWriter({ sql, reader: sql, queue: yield* PersistenceWriteQueue })
        yield* writer.transact(
          Effect.gen(function* () {
            const ended = yield* events.appendInTransaction({ sessionId, events: [finished] })
            yield* events.setCheckpointInTransaction(sessionId, ended.headSequence)
          })
        )
        const trimmed = yield* events.activeProjection({
          sessionId,
          afterSequence: 0,
          throughSequence: 4
        })
        yield* Deferred.succeed(release, undefined)
        const result = yield* delivered(yield* Fiber.join(opening), 5)

        expect(trimmed).toEqual({
          kind: "complete",
          records: [],
          publishedThrough: 5,
          trimFloor: 4
        })
        expect(yield* Ref.get(gate.reads)).toBe(2)
        expect(result).toEqual({
          overflow: undefined,
          snapshot: { kind: "snapshot", applied: 5, checkpoint: 5, active: [] },
          tail: []
        })
      })
    ))
})
