import { Buffer } from "node:buffer"
import { Cause, Effect, Queue, Ref, Scope, Semaphore, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { JournalAppendResult, JournalDelivery, JournalEvent } from "../types.js"
import {
  isJournalStartAt,
  JOURNAL_START_AT,
  JournalError,
  journalError,
  type JournalFollowInput,
  type JournalReadPage,
  type JournalRuntime,
  type JournalRuntimeOptions,
  type OpenJournalFollow
} from "./contracts.js"
import { initializeJournalSchema } from "./schema.js"
import {
  coalescableTail,
  SIGNAL_KIND,
  type Subscriber,
  type SubscriberSignal,
  type Subscribers,
  type TransientSignal,
  type WakeSignal
} from "./subscribers.js"
import {
  DEFAULT_SUBSCRIBER_BYTES,
  DEFAULT_SUBSCRIBER_CAPACITY,
  validateCursor,
  validateStreamId,
  readState
} from "./records.js"
import { appendInTransaction, readPageWithSql, durableRange } from "./store.js"

export const makeJournalRuntime = Effect.fn("Journal.makeRuntime")(function* (
  sql: SqlClient.SqlClient,
  options: JournalRuntimeOptions = {}
): Effect.fn.Return<JournalRuntime, JournalError, Scope.Scope> {
  if (options.initialize !== false) yield* initializeJournalSchema(sql)
  const reader = options.reader ?? sql
  const capacity = options.subscriberCapacity ?? DEFAULT_SUBSCRIBER_CAPACITY
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    return yield* journalError(
      "initialize",
      "invalid_input",
      "subscriberCapacity must be a positive integer"
    )
  }

  const byteCapacity = options.subscriberByteCapacity ?? DEFAULT_SUBSCRIBER_BYTES
  if (!Number.isSafeInteger(byteCapacity) || byteCapacity < 1) {
    return yield* journalError(
      "initialize",
      "invalid_input",
      "subscriberByteCapacity must be a positive integer"
    )
  }

  const subscribers = yield* Effect.acquireRelease(Ref.make<Subscribers>(new Map()), (ref) =>
    Ref.get(ref).pipe(
      Effect.flatMap((current) =>
        Effect.forEach(
          [...current.values()].flatMap((entries) => [...entries]),
          (subscriber) => Queue.shutdown(subscriber.queue),
          { discard: true }
        )
      )
    )
  )
  const writer = yield* Semaphore.make(1)

  const remove = (streamId: string, subscriber: Subscriber) =>
    Ref.update(subscribers, (current) => {
      const entries = current.get(streamId)
      if (entries === undefined || !entries.has(subscriber)) return current
      const next = new Map(current)
      const remaining = new Set(entries)
      remaining.delete(subscriber)
      if (remaining.size === 0) next.delete(streamId)
      else next.set(streamId, remaining)
      return next
    })

  const close = Effect.fn("Journal.makeRuntime.close")(function* (
    streamId: string,
    subscriber: Subscriber,
    overflowed = false
  ) {
    if (overflowed) subscriber.overflowed = true
    subscriber.pendingTail = undefined
    subscriber.queuedRecords = 0
    subscriber.queuedBytes = 0
    yield* remove(streamId, subscriber)
    yield* Queue.shutdown(subscriber.queue)
  })

  const subscribe = Effect.fn("Journal.subscribe")(function* (streamId: string) {
    const queue = yield* Queue.dropping<SubscriberSignal>(capacity)
    const subscriber: Subscriber = {
      queue,
      pendingTail: undefined,
      overflowed: false,
      queuedRecords: 0,
      queuedBytes: 0
    }
    yield* Ref.update(subscribers, (current) => {
      const next = new Map(current)
      const entries = new Set(current.get(streamId))
      entries.add(subscriber)
      next.set(streamId, entries)
      return next
    })
    const scope = yield* Effect.scope
    yield* Scope.addFinalizer(scope, close(streamId, subscriber))
    return subscriber
  })

  const notify = Effect.fn("Journal.notify")(function* (committed: JournalAppendResult) {
    const first = committed.records[0]
    if (first === undefined) return
    const current = (yield* Ref.get(subscribers)).get(first.streamId)
    if (current === undefined) return
    const lastDurableSequence = [...committed.records]
      .reverse()
      .find((record) => record.durable)?.sequence
    const transients = committed.records.filter((record) => !record.durable)
    const transientBytes = transients.reduce(
      (total, record) => total + Buffer.byteLength(JSON.stringify(record), "utf8"),
      0
    )

    for (const subscriber of current) {
      if (lastDurableSequence !== undefined) {
        const wakeTail = coalescableTail(subscriber, SIGNAL_KIND.wake)
        if (wakeTail !== undefined) {
          wakeTail.throughSequence = lastDurableSequence
        } else {
          const wake: WakeSignal = { kind: SIGNAL_KIND.wake, throughSequence: lastDurableSequence }
          const accepted = yield* Queue.offer(subscriber.queue, wake)
          if (!accepted) {
            yield* close(first.streamId, subscriber, true)
            continue
          }
          subscriber.pendingTail = wake
        }
      }

      if (transients.length === 0) continue
      if (
        subscriber.queuedRecords + transients.length > capacity ||
        subscriber.queuedBytes + transientBytes > byteCapacity
      ) {
        yield* close(first.streamId, subscriber, true)
        continue
      }
      subscriber.queuedRecords += transients.length
      subscriber.queuedBytes += transientBytes
      const transientTail = coalescableTail(subscriber, SIGNAL_KIND.transient)
      if (transientTail !== undefined) {
        transientTail.records.push(...transients)
        transientTail.bytes += transientBytes
        continue
      }
      const signal: TransientSignal = {
        kind: SIGNAL_KIND.transient,
        records: [...transients],
        bytes: transientBytes
      }
      const accepted = yield* Queue.offer(subscriber.queue, signal)
      if (!accepted) {
        yield* close(first.streamId, subscriber, true)
        continue
      }
      subscriber.pendingTail = signal
    }
  })

  const watermarks = Effect.fn("Journal.watermarks")(function* (streamId: string) {
    return yield* readState(reader, yield* validateStreamId(streamId, "read"), "read")
  })

  const readPage = Effect.fn("Journal.readPagePublic")(function* (input: JournalReadPage) {
    return yield* readPageWithSql(reader, input, "read")
  })

  const append = Effect.fn("Journal.append")(function* (
    streamId: string,
    events: ReadonlyArray<JournalEvent>
  ) {
    return yield* writer.withPermit(
      Effect.gen(function* () {
        const committed = yield* sql
          .withTransaction(appendInTransaction(sql, streamId, events))
          .pipe(
            Effect.mapError((cause) =>
              cause instanceof JournalError
                ? cause
                : journalError("append", "storage", "Could not commit journal records", cause)
            )
          )
        yield* notify(committed)
        return committed
      })
    )
  })

  const openFollow = Effect.fn("Journal.openFollow")(function* (
    input: JournalFollowInput
  ): Effect.fn.Return<OpenJournalFollow, JournalError, Scope.Scope> {
    const streamId = yield* validateStreamId(input.streamId, "follow")
    const startAt = input.startAt ?? JOURNAL_START_AT.beginning
    if (!isJournalStartAt(startAt)) {
      return yield* journalError("follow", "invalid_input", "startAt must be beginning or latest")
    }
    if (input.afterSequence !== undefined && input.startAt !== undefined) {
      return yield* journalError(
        "follow",
        "invalid_input",
        "Use afterSequence or startAt, not both"
      )
    }
    const replayFloor = yield* validateCursor(input.replayFloor ?? 0, "follow", "replayFloor")
    const subscriber = yield* subscribe(streamId)
    const snapshot = yield* readState(reader, streamId, "follow")
    let cursor = startAt === JOURNAL_START_AT.latest ? snapshot.headSequence : 0
    if (input.afterSequence !== undefined) {
      cursor = yield* validateCursor(input.afterSequence, "follow", "afterSequence")
    }
    let reset: JournalDelivery | undefined
    if (cursor > snapshot.headSequence) {
      cursor = snapshot.headSequence
      reset = { kind: "reset", reason: "future_cursor", cursor }
    } else {
      const retainedFloor =
        snapshot.retainedFromSequence === null ? 0 : snapshot.retainedFromSequence - 1
      const floor = Math.max(replayFloor, retainedFloor)
      if (cursor < floor) {
        cursor = Math.min(snapshot.headSequence, floor)
        reset = { kind: "reset", reason: "replay_gap", cursor }
      }
    }

    const cursorRef = yield* Ref.make(cursor)
    const replay = durableRange(reader, streamId, cursor, snapshot.headSequence, true)
    const initial = reset === undefined ? replay : Stream.concat(Stream.make(reset), replay)
    const ready = Stream.fromEffect(Ref.set(cursorRef, snapshot.headSequence)).pipe(Stream.drain)
    const live = Stream.fromQueue(subscriber.queue).pipe(
      Stream.flatMap((signal) => {
        if (subscriber.pendingTail === signal) subscriber.pendingTail = undefined
        if (signal.kind === SIGNAL_KIND.transient) {
          subscriber.queuedRecords -= signal.records.length
          subscriber.queuedBytes -= signal.bytes
          return Stream.unwrap(
            Ref.get(cursorRef).pipe(
              Effect.map((cursor) => {
                const fresh = signal.records.filter((record) => record.sequence > cursor)
                const last = fresh.at(-1)
                return last === undefined
                  ? Stream.empty
                  : Stream.fromEffect(Ref.set(cursorRef, last.sequence)).pipe(
                      Stream.drain,
                      Stream.concat(
                        Stream.fromIterable(
                          fresh.map(
                            (record) =>
                              ({
                                kind: "record",
                                record,
                                replayed: false
                              }) as const
                          )
                        )
                      )
                    )
              })
            )
          )
        }
        return Stream.unwrap(
          Ref.get(cursorRef).pipe(
            Effect.map((afterSequence) =>
              durableRange(reader, streamId, afterSequence, signal.throughSequence, false).pipe(
                Stream.concat(
                  Stream.fromEffect(
                    Ref.update(cursorRef, (current) => Math.max(current, signal.throughSequence))
                  ).pipe(Stream.drain)
                )
              )
            )
          )
        )
      }),
      Stream.catchCause((cause) => {
        if (subscriber.overflowed)
          return Stream.fromEffect(Ref.get(cursorRef)).pipe(
            Stream.map((cursor): JournalDelivery => ({ kind: "overflow", cursor }))
          )
        return Cause.hasInterruptsOnly(cause) ? Stream.empty : Stream.failCause(cause)
      })
    )
    return {
      initialSequence: cursor,
      stream: initial.pipe(Stream.concat(ready), Stream.concat(live))
    }
  })

  const follow = (input: JournalFollowInput): Stream.Stream<JournalDelivery, JournalError> =>
    Stream.unwrap(openFollow(input).pipe(Effect.map((opened) => opened.stream)))

  return { append, notify, watermarks, readPage, openFollow, follow }
})
