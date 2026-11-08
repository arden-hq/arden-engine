import { Buffer } from "node:buffer"
import {
  Cause,
  DateTime,
  Effect,
  Option,
  Queue,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream
} from "effect"
import { SqlClient, type Statement } from "effect/unstable/sql"
import type {
  JournalAppendResult,
  JournalDelivery,
  JournalEvent,
  JournalRecord,
  JsonValue
} from "../types.js"

const PAGE_SIZE = 512
const DEFAULT_SUBSCRIBER_CAPACITY = 4_096
const DEFAULT_SUBSCRIBER_BYTES = 8 * 1024 * 1024

const NonEmptyText = Schema.String.check(Schema.isMinLength(1))
const EventSchema = Schema.Struct({
  type: NonEmptyText,
  data: Schema.Json,
  attributes: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  durable: Schema.optionalKey(Schema.Boolean)
})
const EventBatchSchema = Schema.Array(EventSchema).check(
  Schema.isMinLength(1),
  Schema.makeFilter((events) => {
    let sawTransient = false
    const issues: Array<Schema.FilterIssue> = []
    for (const [index, event] of events.entries()) {
      if (event.durable === false) sawTransient = true
      else if (sawTransient) {
        issues.push({
          path: [index, "durable"],
          issue: "Durable records must precede live-only records"
        })
      }
    }
    return issues
  })
)

export type JournalOperation = "initialize" | "append" | "read" | "follow" | "retain"

export class JournalError extends Schema.TaggedError<JournalError>()("JournalError", {
  operation: Schema.Literals(["initialize", "append", "read", "follow", "retain"] as const),
  kind: Schema.Literals(["invalid_input", "storage", "corrupt_data"] as const),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {}

export const journalSqliteSchema = {
  tables: ["journal_streams", "journal_records"],
  indexes: [],
  statements: [
    `CREATE TABLE IF NOT EXISTS journal_streams (
      stream_id TEXT PRIMARY KEY,
      head_sequence INTEGER NOT NULL CHECK (head_sequence >= 0),
      retained_from_sequence INTEGER CHECK (
        retained_from_sequence IS NULL OR
        (retained_from_sequence >= 1 AND retained_from_sequence <= head_sequence)
      )
    )`,
    `CREATE TABLE IF NOT EXISTS journal_records (
      stream_id TEXT NOT NULL REFERENCES journal_streams(stream_id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      event_type TEXT NOT NULL CHECK (length(event_type) > 0),
      data_json TEXT NOT NULL,
      attributes_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (stream_id, sequence)
    )`
  ]
} as const

export interface JournalWatermarks {
  readonly headSequence: number
  readonly retainedFromSequence: number | null
}

export interface JournalReadPage {
  readonly streamId: string
  readonly afterSequence: number
  readonly throughSequence: number
  readonly limit?: number
}

export interface JournalFollowInput {
  readonly streamId: string
  readonly afterSequence?: number
  readonly startAt?: "beginning" | "latest"
  readonly replayFloor?: number
}

export interface JournalRuntimeOptions {
  readonly initialize?: boolean
  readonly subscriberCapacity?: number
  readonly subscriberByteCapacity?: number
}

export interface OpenJournalFollow {
  /** Cursor held before this stream emits its first replay/reset record. */
  readonly initialSequence: number
  readonly stream: Stream.Stream<JournalDelivery, JournalError>
}

export interface JournalRuntime {
  readonly append: (
    streamId: string,
    events: ReadonlyArray<JournalEvent>
  ) => Effect.Effect<JournalAppendResult, JournalError>
  readonly notify: (committed: JournalAppendResult) => Effect.Effect<void>
  readonly watermarks: (streamId: string) => Effect.Effect<JournalWatermarks, JournalError>
  readonly readPage: (
    input: JournalReadPage
  ) => Effect.Effect<ReadonlyArray<JournalRecord>, JournalError>
  readonly openFollow: (
    input: JournalFollowInput
  ) => Effect.Effect<OpenJournalFollow, JournalError, Scope.Scope>
  readonly follow: (input: JournalFollowInput) => Stream.Stream<JournalDelivery, JournalError>
}

interface StreamRow {
  readonly head_sequence: number
  readonly retained_from_sequence: number | null
}

interface RecordRow {
  readonly stream_id: string
  readonly sequence: number
  readonly event_type: string
  readonly data_json: string
  readonly attributes_json: string
  readonly created_at: string
}

interface WakeSignal {
  readonly kind: "wake"
  throughSequence: number
}

interface TransientSignal {
  readonly kind: "transient"
  readonly records: Array<JournalRecord>
  bytes: number
}

type SubscriberSignal = WakeSignal | TransientSignal

interface Subscriber {
  readonly queue: Queue.Queue<SubscriberSignal>
  pendingTail: SubscriberSignal | undefined
  overflowed: boolean
  queuedRecords: number
  queuedBytes: number
}

const coalescableTail = <K extends SubscriberSignal["kind"]>(
  subscriber: Subscriber,
  kind: K
): Extract<SubscriberSignal, { readonly kind: K }> | undefined =>
  subscriber.pendingTail?.kind === kind
    ? (subscriber.pendingTail as Extract<SubscriberSignal, { readonly kind: K }>)
    : undefined

type Subscribers = Map<string, Set<Subscriber>>

const journalError = (
  operation: JournalOperation,
  kind: "invalid_input" | "storage" | "corrupt_data",
  message: string,
  cause?: unknown
): JournalError =>
  new JournalError({
    operation,
    kind,
    message,
    ...(cause === undefined ? {} : { cause })
  })

const validateCursor = (
  value: number,
  operation: JournalOperation,
  label: string
): Effect.Effect<number, JournalError> =>
  Number.isSafeInteger(value) && value >= 0
    ? Effect.succeed(value)
    : Effect.fail(
        journalError(operation, "invalid_input", `${label} must be a non-negative safe integer`)
      )

const validateStreamId = (
  streamId: string,
  operation: JournalOperation
): Effect.Effect<string, JournalError> =>
  typeof streamId === "string" && streamId.length > 0
    ? Effect.succeed(streamId)
    : Effect.fail(journalError(operation, "invalid_input", "streamId must be a non-empty string"))

const freezeJson = <A extends JsonValue | Readonly<Record<string, JsonValue>>>(value: A): A => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) freezeJson(nested)
  return Object.freeze(value)
}

const freezeRecord = (record: JournalRecord): JournalRecord =>
  Object.freeze({
    ...record,
    data: freezeJson(record.data),
    attributes: freezeJson(record.attributes)
  })

const readState = Effect.fn("Journal.readState")(function* (
  sql: SqlClient.SqlClient,
  streamId: string,
  operation: "append" | "read" | "follow"
): Effect.fn.Return<JournalWatermarks, JournalError> {
  const rows = yield* sql<StreamRow>`
    SELECT head_sequence, retained_from_sequence
    FROM journal_streams
    WHERE stream_id = ${streamId}
  `.pipe(
    Effect.mapError((cause) =>
      journalError(operation, "storage", "Could not read journal stream", cause)
    )
  )
  const row = rows[0]
  return row === undefined
    ? { headSequence: 0, retainedFromSequence: null }
    : { headSequence: row.head_sequence, retainedFromSequence: row.retained_from_sequence }
})

const decodeRow = (
  row: RecordRow,
  operation: "read" | "follow"
): Effect.Effect<JournalRecord, JournalError> =>
  Effect.try({
    try: () => {
      const data = Schema.decodeUnknownSync(Schema.Json)(JSON.parse(row.data_json))
      const attributes = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
        JSON.parse(row.attributes_json)
      ) as Readonly<Record<string, JsonValue>>
      if (!Number.isSafeInteger(row.sequence) || row.sequence < 1 || row.event_type.length === 0) {
        throw new Error("Invalid journal record fields")
      }
      if (Number.isNaN(Date.parse(row.created_at))) throw new Error("Invalid journal timestamp")
      return freezeRecord({
        streamId: row.stream_id,
        sequence: row.sequence,
        type: row.event_type,
        data,
        attributes,
        durable: true,
        createdAt: row.created_at
      })
    },
    catch: (cause) =>
      journalError(operation, "corrupt_data", "Stored journal record is corrupt", cause)
  })

export const initializeJournalSchema = Effect.fn("Journal.initializeSchema")(function* (
  sql: SqlClient.SqlClient
): Effect.fn.Return<void, JournalError> {
  yield* Effect.forEach(journalSqliteSchema.statements, (statement) => sql.unsafe(statement), {
    discard: true
  }).pipe(
    Effect.mapError((cause) =>
      journalError("initialize", "storage", "Could not initialize journal schema", cause)
    )
  )
  yield* Effect.forEach(
    [
      "SELECT stream_id, head_sequence, retained_from_sequence FROM journal_streams LIMIT 0",
      `SELECT stream_id, sequence, event_type, data_json, attributes_json, created_at
     FROM journal_records LIMIT 0`
    ],
    (statement) => sql.unsafe(statement),
    { discard: true }
  ).pipe(
    Effect.mapError((cause) =>
      journalError("initialize", "storage", "Existing journal schema is incompatible", cause)
    )
  )
})

/** Write journal state and rows inside a transaction owned by the caller. */
export const appendInTransaction = Effect.fn("Journal.appendInTransaction")(function* (
  sql: SqlClient.SqlClient,
  streamId: string,
  events: ReadonlyArray<JournalEvent>
): Effect.fn.Return<JournalAppendResult, JournalError> {
  const validStreamId = yield* validateStreamId(streamId, "append")
  const validEvents = yield* Schema.decodeUnknownEffect(EventBatchSchema)(events).pipe(
    Effect.mapError((cause) =>
      journalError("append", "invalid_input", "Invalid journal event batch", cause)
    )
  )
  const snapshots = validEvents.map((event) => ({
    type: event.type,
    dataJson: JSON.stringify(event.data),
    attributesJson: JSON.stringify(event.attributes ?? {}),
    durable: event.durable !== false
  }))
  const current = yield* readState(sql, validStreamId, "append")
  const createdAt = DateTime.formatIso(yield* DateTime.now)
  const records = snapshots.map((event, index) =>
    freezeRecord({
      streamId: validStreamId,
      sequence: current.headSequence + index + 1,
      type: event.type,
      data: JSON.parse(event.dataJson) as JsonValue,
      attributes: JSON.parse(event.attributesJson) as Readonly<Record<string, JsonValue>>,
      durable: event.durable,
      createdAt
    })
  )
  const headSequence = current.headSequence + records.length
  const firstDurable = records.find((record) => record.durable)?.sequence ?? null
  const retainedFromSequence = current.retainedFromSequence ?? firstDurable

  yield* sql`
    INSERT INTO journal_streams (stream_id, head_sequence, retained_from_sequence)
    VALUES (${validStreamId}, ${headSequence}, ${retainedFromSequence})
    ON CONFLICT(stream_id) DO UPDATE SET
      head_sequence = excluded.head_sequence,
      retained_from_sequence = excluded.retained_from_sequence
  `.pipe(
    Effect.mapError((cause) =>
      journalError("append", "storage", "Could not advance journal stream", cause)
    )
  )

  for (const [index, snapshot] of snapshots.entries()) {
    if (!snapshot.durable) continue
    yield* sql`
      INSERT INTO journal_records (
        stream_id, sequence, event_type, data_json, attributes_json, created_at
      ) VALUES (
        ${validStreamId}, ${current.headSequence + index + 1}, ${snapshot.type}, ${snapshot.dataJson},
        ${snapshot.attributesJson}, ${createdAt}
      )
    `.pipe(
      Effect.mapError((cause) =>
        journalError("append", "storage", "Could not persist journal record", cause)
      )
    )
  }

  return Object.freeze({ records: Object.freeze(records), headSequence })
})

/** The records table as a SQL fragment, for callers that filter or join
 * records inside their own queries. Its columns are `stream_id`, `sequence`,
 * `event_type`, `data_json`, `attributes_json` and `created_at`. */
export const journalRecordsSql = (sql: SqlClient.SqlClient): Statement.Fragment =>
  sql.literal("journal_records")

/** The streams table as a SQL fragment, for callers that read a stream's
 * watermarks together with their own rows in one statement. Its columns are
 * `stream_id`, `head_sequence` and `retained_from_sequence`. */
export const journalStreamsSql = (sql: SqlClient.SqlClient): Statement.Fragment =>
  sql.literal("journal_streams")

/** Scalar subquery: the stream's head sequence, or NULL when the stream has
 * never been appended to. `streamId` may be a column reference. */
export const journalHeadSequenceSql = (
  sql: SqlClient.SqlClient,
  streamId: string | Statement.Fragment
): Statement.Fragment =>
  sql`(SELECT head_sequence FROM journal_streams WHERE stream_id = ${streamId})`

/** {@link journalHeadSequenceSql} as plain SQL with one `?` for the stream id,
 * for callers on a raw SQLite handle, such as a schema conversion. */
export const JOURNAL_HEAD_SEQUENCE_SQL =
  "(SELECT head_sequence FROM journal_streams WHERE stream_id = ?)"

/** The stream's head sequence, or `undefined` when the stream has never been
 * appended to. Joins the caller's transaction when it runs inside one. */
export const readHeadSequence = Effect.fn("Journal.readHeadSequence")(function* (
  sql: SqlClient.SqlClient,
  streamId: string
): Effect.fn.Return<number | undefined, JournalError> {
  const rows = yield* sql<Pick<StreamRow, "head_sequence">>`
    SELECT head_sequence FROM journal_streams WHERE stream_id = ${streamId} LIMIT 1
  `.pipe(
    Effect.mapError((cause) =>
      journalError("read", "storage", "Could not read journal head", cause)
    )
  )
  return rows[0]?.head_sequence
})

/** Move the replay floor up to `fromSequence` (at most the head, never down)
 * and delete the records below it. The head record is never deleted. Runs
 * inside a transaction owned by the caller. */
export const retainFromInTransaction = Effect.fn("Journal.retainFromInTransaction")(function* (
  sql: SqlClient.SqlClient,
  input: { readonly streamId: string; readonly fromSequence: number }
): Effect.fn.Return<void, JournalError> {
  if (!Number.isSafeInteger(input.fromSequence) || input.fromSequence < 1) {
    return yield* journalError("retain", "invalid_input", "fromSequence must be a positive integer")
  }
  yield* sql`
    DELETE FROM journal_records
    WHERE stream_id = ${input.streamId}
      AND sequence < (
        SELECT MIN(${input.fromSequence}, head_sequence)
        FROM journal_streams WHERE stream_id = ${input.streamId}
      )
  `.pipe(
    Effect.mapError((cause) =>
      journalError("retain", "storage", "Could not delete journal records", cause)
    )
  )
  yield* sql`
    UPDATE journal_streams
    SET retained_from_sequence = MAX(
      COALESCE(retained_from_sequence, 1),
      MIN(${input.fromSequence}, head_sequence)
    )
    WHERE stream_id = ${input.streamId} AND head_sequence > 0
  `.pipe(
    Effect.mapError((cause) =>
      journalError("retain", "storage", "Could not advance journal replay floor", cause)
    )
  )
})

/** Delete the stream and, by cascade, all its records. Runs inside a
 * transaction owned by the caller. */
export const deleteStreamInTransaction = Effect.fn("Journal.deleteStreamInTransaction")(function* (
  sql: SqlClient.SqlClient,
  streamId: string
): Effect.fn.Return<void, JournalError> {
  yield* sql`DELETE FROM journal_streams WHERE stream_id = ${streamId}`.pipe(
    Effect.mapError((cause) =>
      journalError("retain", "storage", "Could not delete journal stream", cause)
    )
  )
})

/** Delete the records below `beforeSequence` that match `where`, a condition
 * over the record columns, and return how many were deleted. The replay floor
 * does not move: followers skip the gaps. Runs inside a transaction owned by
 * the caller. */
export const truncateBeforeInTransaction = Effect.fn("Journal.truncateBeforeInTransaction")(
  function* (
    sql: SqlClient.SqlClient,
    input: {
      readonly streamId: string
      readonly beforeSequence: number
      readonly where: Statement.Fragment
    }
  ): Effect.fn.Return<number, JournalError> {
    const deleted = yield* sql<{ readonly sequence: number }>`
    DELETE FROM journal_records
    WHERE stream_id = ${input.streamId}
      AND sequence < ${input.beforeSequence}
      AND (${input.where})
    RETURNING sequence
  `.pipe(
      Effect.mapError((cause) =>
        journalError("retain", "storage", "Could not delete journal records", cause)
      )
    )
    return deleted.length
  }
)

const readPageWithSql = Effect.fn("Journal.readPage")(function* (
  sql: SqlClient.SqlClient,
  input: JournalReadPage,
  operation: "read" | "follow"
): Effect.fn.Return<ReadonlyArray<JournalRecord>, JournalError> {
  const streamId = yield* validateStreamId(input.streamId, operation)
  const afterSequence = yield* validateCursor(input.afterSequence, operation, "afterSequence")
  const throughSequence = yield* validateCursor(input.throughSequence, operation, "throughSequence")
  const limit = input.limit ?? PAGE_SIZE
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    return yield* journalError(
      operation,
      "invalid_input",
      "limit must be an integer from 1 to 10000"
    )
  }
  const rows = yield* sql<RecordRow>`
    SELECT stream_id, sequence, event_type, data_json, attributes_json, created_at
    FROM journal_records
    WHERE stream_id = ${streamId}
      AND sequence > ${afterSequence}
      AND sequence <= ${throughSequence}
    ORDER BY sequence ASC
    LIMIT ${limit}
  `.pipe(
    Effect.mapError((cause) =>
      journalError(operation, "storage", "Could not read journal records", cause)
    )
  )
  return yield* Effect.forEach(rows, (row) => decodeRow(row, operation))
})

const durableRange = (
  sql: SqlClient.SqlClient,
  streamId: string,
  afterSequence: number,
  throughSequence: number,
  replayed: boolean
): Stream.Stream<JournalDelivery, JournalError> =>
  Stream.paginate(afterSequence, (cursor) =>
    readPageWithSql(
      sql,
      {
        streamId,
        afterSequence: cursor,
        throughSequence,
        limit: PAGE_SIZE
      },
      "follow"
    ).pipe(
      Effect.map((records) => {
        const next = records.at(-1)?.sequence
        return [
          records.map((record) => ({ kind: "record", record, replayed }) as const),
          next === undefined || records.length < PAGE_SIZE
            ? Option.none<number>()
            : Option.some(next)
        ] as const
      })
    )
  )

export const makeJournalRuntime = Effect.fn("Journal.makeRuntime")(function* (
  sql: SqlClient.SqlClient,
  options: JournalRuntimeOptions = {}
): Effect.fn.Return<JournalRuntime, JournalError, Scope.Scope> {
  if (options.initialize !== false) yield* initializeJournalSchema(sql)
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
        const wakeTail = coalescableTail(subscriber, "wake")
        if (wakeTail !== undefined) {
          wakeTail.throughSequence = lastDurableSequence
        } else {
          const wake: WakeSignal = { kind: "wake", throughSequence: lastDurableSequence }
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
      const transientTail = coalescableTail(subscriber, "transient")
      if (transientTail !== undefined) {
        transientTail.records.push(...transients)
        transientTail.bytes += transientBytes
        continue
      }
      const signal: TransientSignal = {
        kind: "transient",
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
    return yield* readState(sql, yield* validateStreamId(streamId, "read"), "read")
  })

  const readPage = Effect.fn("Journal.readPagePublic")(function* (input: JournalReadPage) {
    return yield* readPageWithSql(sql, input, "read")
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
    const startAt = input.startAt ?? "beginning"
    if (startAt !== "beginning" && startAt !== "latest") {
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
    const snapshot = yield* readState(sql, streamId, "follow")
    let cursor = startAt === "latest" ? snapshot.headSequence : 0
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
    const replay = durableRange(sql, streamId, cursor, snapshot.headSequence, true)
    const initial = reset === undefined ? replay : Stream.concat(Stream.make(reset), replay)
    const ready = Stream.fromEffect(Ref.set(cursorRef, snapshot.headSequence)).pipe(Stream.drain)
    const live = Stream.fromQueue(subscriber.queue).pipe(
      Stream.flatMap((signal) => {
        if (subscriber.pendingTail === signal) subscriber.pendingTail = undefined
        if (signal.kind === "transient") {
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
              durableRange(sql, streamId, afterSequence, signal.throughSequence, false).pipe(
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
