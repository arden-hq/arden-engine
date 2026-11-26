import type {
  SnapshotProjectionEvent,
  StreamLiveEvent,
  StreamOverflowEvent,
  StreamSnapshotEvent
} from "@arden-hq/protocol"
import type { HistoryResponse } from "@arden-hq/protocol/chat"
import { randomUUID } from "node:crypto"
import {
  Context,
  DateTime,
  Cause,
  type Duration,
  Effect,
  Exit,
  Layer,
  Ref,
  Result,
  Schedule,
  Schema,
  Scope,
  Stream
} from "effect"
import { Event as SseEvent } from "effect/unstable/encoding/Sse"
import type { SessionEventRecord } from "../persistence/events/model.js"
import {
  ChatEventStore,
  type ChatEventDelivery,
  type ChatEventStoreError
} from "../persistence/events/store.js"
import { Persistence } from "../persistence/service.js"
import { boundConversationWindow } from "./history-budget.js"
import { encodeSnapshotJson, snapshotJsonBytes } from "./snapshot-encoding.js"
import { ChatHistory, type HistoryRead } from "./history.js"
import type { ChatHistoryFailure } from "./history-errors.js"
import { errorMessage } from "@arden-hq/std/errors"
import {
  chatOpenTimer,
  chatOpenTracingEnabled,
  logChatOpenTiming,
  type ChatOpenTimingPhase,
  type ChatOpenTimer
} from "./open-timing.js"

const KEEPALIVE_INTERVAL = "5 seconds"
const RESUME_SNAPSHOT_CAPACITY_BYTES = 8 * 1024 * 1024
const RESUME_SNAPSHOT_CAPACITY_EVENTS = 4_096
const RESUME_REPLAY_PAGE_SIZE = 1_000
const RESUME_HISTORY_CAPACITY_BYTES = RESUME_SNAPSHOT_CAPACITY_BYTES / 2
const RESUME_HISTORY_WINDOW_LIMIT = 100

export class ChatStreamError extends Schema.TaggedError<ChatStreamError>()("ChatStreamError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {}

interface ChatEventStreamOptions {
  readonly sessionId: string
  readonly requestId?: string | undefined
  readonly collectTiming?: boolean | undefined
}

interface ChatEventStreamOpenResult {
  readonly stream: Stream.Stream<SseEvent, ChatStreamError>
  readonly timings?: Readonly<Partial<Record<ChatOpenTimingPhase, number>>> | undefined
}

export interface ChatEventStreamShape {
  readonly open: (
    input: ChatEventStreamOptions
  ) => Effect.Effect<ChatEventStreamOpenResult, ChatStreamError, Scope.Scope>
}

export class ChatEventStream extends Context.Service<ChatEventStream, ChatEventStreamShape>()(
  "@arden-hq/server/chat/ChatEventStream"
) {
  static readonly layer = Layer.effect(
    ChatEventStream,
    Effect.gen(function* () {
      const events = yield* ChatEventStore
      const history = yield* ChatHistory
      const persistence = yield* Persistence

      const open = Effect.fn("ChatEventStream.open")(function* (
        input: ChatEventStreamOptions
      ): Effect.fn.Return<ChatEventStreamOpenResult, ChatStreamError, Scope.Scope> {
        const requestId = input.collectTiming === true ? input.requestId : undefined
        const timer = chatOpenTimer(requestId)
        const resumeId = timer === undefined ? undefined : (requestId ?? randomUUID())
        const stream = yield* openResumeStream({
          events,
          history,
          persistence,
          input,
          timer,
          resumeId
        }).pipe(
          Effect.onExit((exit) => {
            if (timer === undefined || !chatOpenTracingEnabled()) return Effect.void
            let result: "success" | "interrupted" | "failure"
            if (Exit.isSuccess(exit)) result = "success"
            else if (Cause.hasInterruptsOnly(exit.cause)) result = "interrupted"
            else result = "failure"
            return logChatOpenTiming("chat.resume_outcome", {
              resumeId,
              result,
              totalMs: timer.total()
            })
          })
        )
        return {
          stream,
          ...(requestId === undefined || timer === undefined ? {} : { timings: timer.timings() })
        }
      })

      return ChatEventStream.of({ open })
    })
  )
}

interface OpenResumeStreamInput {
  readonly events: ChatEventStore["Service"]
  readonly history: ChatHistory["Service"]
  readonly persistence: Persistence["Service"]
  readonly input: ChatEventStreamOptions
  readonly timer: ChatOpenTimer | undefined
  readonly resumeId: string | undefined
}

type ResumeProjection =
  | {
      readonly kind: "complete"
      readonly appliedSequence: number
      readonly snapshotData: string
    }
  | {
      readonly kind: "overflow"
      readonly safeCursor: number
    }

type DurableResumeRange =
  | {
      readonly kind: "complete"
      readonly records: ReadonlyArray<SessionEventRecord>
    }
  | {
      readonly kind: "overflow"
    }

interface ResumeSnapshotBudget {
  readonly bytes: number
  readonly eventCount: number
  readonly occupiedSequences: ReadonlySet<number>
}

/** What one read of the database and the in-memory projection gives. */
type ResumeRead =
  | {
      readonly kind: "overflow"
      readonly result: "active_overflow" | "initial_budget_overflow" | "durable_overflow"
      readonly checkpointSequence: number
      readonly activeEventCount: number
      readonly initialSnapshotBytes: number | undefined
    }
  | {
      readonly kind: "complete"
      readonly history: HistoryRead
      readonly appliedSequence: number
      readonly checkpointSequence: number
      readonly active: ReadonlyArray<SessionEventRecord>
      readonly durable: ReadonlyArray<SessionEventRecord>
    }

/**
 * Whether the projection must be shown to agree with the database read.
 * "checked" for a snapshot beside the write queue; "trusted" inside the write
 * queue, where every commit has been applied before the read starts.
 */
type ResumeCoverage = "checked" | "trusted"

/** The in-memory projection disagreed with the snapshot's commit point. */
class ResumeSnapshotStale extends Schema.TaggedError<ResumeSnapshotStale>()("ResumeSnapshotStale", {
  appliedSequence: Schema.Int,
  checkpointSequence: Schema.Int,
  publishedThrough: Schema.Int,
  trimFloor: Schema.Int
}) {}

// A commit is applied to the projection right after COMMIT, so a stale
// snapshot is current again within milliseconds: three more tries over about
// 35 ms, then the write-queue read.
const resumeSnapshotRetry = {
  times: 3,
  schedule: Schedule.exponential("5 millis"),
  while: (error: unknown) => error instanceof ResumeSnapshotStale
}

/**
 * Opening a chat sends one snapshot and then the live tail, with every
 * journal sequence in exactly one of them. The follower subscribes first.
 * Then one read transaction on a reader connection (`Persistence.snapshot`)
 * reads history, run, approvals, the journal head A and the checkpoint C at
 * one commit point, without waiting for the writer. The handover point P is
 * that A: the snapshot holds the transaction's rows plus the in-memory
 * projection's records in (C, P], and the tail drops every follower record at
 * or below P. The projection is not part of the transaction, so the snapshot
 * counts only when it agrees with A and C: it has applied every commit
 * through P (`publishedThrough >= P`, else live-only records at or below P
 * would be in neither part) and has dropped no record above C (`trimFloor <=
 * C`, else a run that ended or restarted after the transaction began took
 * records the transaction still needs). A disagreement is retried; if it
 * persists, the capture runs inside the write queue (`consistentRead`), where
 * the projection and the database agree by construction.
 */
const openResumeStream = Effect.fn("ChatEventStream.openResume")(function* (
  options: OpenResumeStreamInput
): Effect.fn.Return<Stream.Stream<SseEvent, ChatStreamError>, ChatStreamError, Scope.Scope> {
  const opened = yield* options.events
    .openFollow({
      sessionId: options.input.sessionId,
      startAt: "latest"
    })
    .pipe(Effect.mapError(toStreamError))
  const followerMs = options.timer?.mark("resume_follower")
  const capture = captureResumeProjection({
    events: options.events,
    history: options.history,
    persistence: options.persistence,
    sessionId: options.input.sessionId,
    timer: options.timer
  })
  const projection = yield* (
    options.resumeId === undefined
      ? capture
      : capture.pipe(Effect.annotateLogs("resume_id", options.resumeId))
  ).pipe(Effect.mapError(toStreamError))
  const captureTotalMs = options.timer?.mark("resume_total")

  if (options.timer !== undefined && chatOpenTracingEnabled()) {
    yield* logChatOpenTiming("chat.resume_timing", {
      resumeId: options.resumeId,
      followerMs,
      captureTotalMs,
      totalMs: options.timer.total(),
      result: projection.kind
    })
  }

  if (projection.kind === "overflow") {
    return Stream.make(
      overflowEvent(options.input.sessionId, projection.safeCursor, "active_projection")
    )
  }

  const snapshot = snapshotEvent(projection.appliedSequence, projection.snapshotData)
  const live = liveEvent(options.input.sessionId, projection.appliedSequence)
  const tail = opened.stream.pipe(
    Stream.filterMap((delivery) =>
      resumeDeliveryToSse(delivery, options.input.sessionId, projection.appliedSequence)
    ),
    Stream.mapError(toStreamError)
  )
  return withKeepalives(
    Stream.make(snapshot, live).pipe(Stream.concat(tail)),
    options.input.sessionId,
    projection.appliedSequence
  )
})

const captureResumeProjection = Effect.fn("ChatEventStream.captureResumeProjection")(function* (
  input: Pick<OpenResumeStreamInput, "events" | "history" | "persistence" | "timer"> & {
    readonly sessionId: string
  }
): Effect.fn.Return<ResumeProjection, unknown> {
  const { timer } = input
  const read = (coverage: ResumeCoverage) => readResume({ ...input, coverage })
  const captured = yield* input.persistence.snapshot(read("checked")).pipe(
    Effect.retry(resumeSnapshotRetry),
    Effect.catchTag("ResumeSnapshotStale", (stale) =>
      Effect.logInfo("Chat open read the write queue: the projection lagged the snapshot", {
        appliedSequence: stale.appliedSequence,
        checkpointSequence: stale.checkpointSequence,
        publishedThrough: stale.publishedThrough,
        trimFloor: stale.trimFloor
      }).pipe(Effect.andThen(input.persistence.consistentRead(read("trusted"))))
    )
  )
  const report = (result: string, fields: Readonly<Record<string, number | undefined>>) =>
    timer === undefined || !chatOpenTracingEnabled()
      ? Effect.void
      : logChatOpenTiming("chat.resume_capture_timing", {
          ...fields,
          totalMs: timer.total(),
          result
        })
  if (captured.kind === "overflow") {
    yield* report(captured.result, {
      activeEventCount: captured.activeEventCount,
      initialSnapshotBytes: captured.initialSnapshotBytes
    })
    return { kind: "overflow", safeCursor: captured.checkpointSequence }
  }

  const history = yield* input.history.withBudget(captured.history)
  const bySequence = new Map<number, SessionEventRecord>()
  for (const record of captured.durable) bySequence.set(record.sequence, record)
  for (const record of captured.active) bySequence.set(record.sequence, record)
  const activeEvents = [...bySequence.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .map(eventRecordToProjectionEvent)
  const encoded = encodeSnapshotJson(
    snapshotProtocolEvent(input.sessionId, captured.appliedSequence, history, activeEvents)
  )
  if (
    activeEvents.length > RESUME_SNAPSHOT_CAPACITY_EVENTS ||
    encoded.bytes > RESUME_SNAPSHOT_CAPACITY_BYTES
  ) {
    yield* report("final_budget_overflow", { activeEventCount: activeEvents.length })
    return { kind: "overflow", safeCursor: captured.checkpointSequence }
  }
  yield* report("complete", {
    finalProjectionMs: timer?.mark("resume_final_projection"),
    activeEventCount: activeEvents.length,
    finalSnapshotBytes: encoded.bytes
  })
  return { kind: "complete", appliedSequence: captured.appliedSequence, snapshotData: encoded.data }
})

/** Every database statement here runs on a reader: inside `Persistence.snapshot`
 * a statement on the writer would run outside the transaction and wait for it. */
const readResume = Effect.fn("ChatEventStream.readResume")(function* (input: {
  readonly events: ChatEventStore["Service"]
  readonly history: ChatHistory["Service"]
  readonly sessionId: string
  readonly coverage: ResumeCoverage
  readonly timer: ChatOpenTimer | undefined
}): Effect.fn.Return<
  ResumeRead,
  ChatHistoryFailure | ChatEventStoreError | ChatStreamError | ResumeSnapshotStale
> {
  const { events, sessionId, timer } = input
  // Time spent waiting for a snapshot permit, or for the write queue.
  timer?.mark("resume_capture_queue")
  const loaded = yield* input.history.read({ sessionId, limit: RESUME_HISTORY_WINDOW_LIMIT })
  timer?.mark("resume_history")
  const history = boundConversationWindow(loaded.history, RESUME_HISTORY_CAPACITY_BYTES)
  const checkpointSequence = history.runtime.checkpoint_seq
  const appliedSequence = history.runtime.latest_event_seq
  const active = yield* events.activeProjection({
    sessionId,
    afterSequence: checkpointSequence,
    throughSequence: appliedSequence
  })
  timer?.mark("resume_active_projection")
  if (
    input.coverage === "checked" &&
    (active.publishedThrough < appliedSequence || active.trimFloor > checkpointSequence)
  ) {
    return yield* new ResumeSnapshotStale({
      appliedSequence,
      checkpointSequence,
      publishedThrough: active.publishedThrough,
      trimFloor: active.trimFloor
    })
  }
  if (active.kind === "overflow") {
    return {
      kind: "overflow",
      result: "active_overflow",
      checkpointSequence,
      activeEventCount: 0,
      initialSnapshotBytes: undefined
    }
  }

  // An estimate that bounds the durable read: the snapshot's envelope and the
  // context budget, which joins after the transaction, are counted only by the
  // final check on the encoded snapshot.
  const projectedActive = active.records.map(eventRecordToProjectionEvent)
  const initialBytes = snapshotJsonBytes(history) + snapshotJsonBytes(projectedActive)
  timer?.mark("resume_initial_projection")
  if (
    projectedActive.length > RESUME_SNAPSHOT_CAPACITY_EVENTS ||
    initialBytes > RESUME_SNAPSHOT_CAPACITY_BYTES
  ) {
    return {
      kind: "overflow",
      result: "initial_budget_overflow",
      checkpointSequence,
      activeEventCount: active.records.length,
      initialSnapshotBytes: initialBytes
    }
  }

  const durable = yield* readDurableRange({
    events,
    sessionId,
    afterSequence: checkpointSequence,
    throughSequence: appliedSequence,
    budget: {
      bytes: initialBytes,
      eventCount: projectedActive.length,
      occupiedSequences: new Set(active.records.map((record) => record.sequence))
    }
  })
  timer?.mark("resume_durable_range")
  if (durable.kind === "overflow") {
    return {
      kind: "overflow",
      result: "durable_overflow",
      checkpointSequence,
      activeEventCount: active.records.length,
      initialSnapshotBytes: initialBytes
    }
  }
  return {
    kind: "complete",
    history: { history, budget: loaded.budget },
    appliedSequence,
    checkpointSequence,
    active: active.records,
    durable: durable.records
  }
})

const readDurableRange = Effect.fn("ChatEventStream.readDurableRange")(function* (input: {
  readonly events: ChatEventStore["Service"]
  readonly sessionId: string
  readonly afterSequence: number
  readonly throughSequence: number
  readonly budget: ResumeSnapshotBudget
}): Effect.fn.Return<DurableResumeRange, ChatEventStoreError | ChatStreamError> {
  const records: Array<SessionEventRecord> = []
  let cursor = input.afterSequence
  let bytes = input.budget.bytes
  let eventCount = input.budget.eventCount
  while (cursor < input.throughSequence) {
    const page = yield* input.events
      .readPage({
        sessionId: input.sessionId,
        afterSequence: cursor,
        throughSequence: input.throughSequence,
        limit: RESUME_REPLAY_PAGE_SIZE,
        capacityBytes: RESUME_SNAPSHOT_CAPACITY_BYTES - bytes
      })
      .pipe(Effect.catchTag("ChatEventPageOverflow", () => Effect.succeed(undefined)))
    if (page === undefined) return { kind: "overflow" }
    for (const record of page.records) {
      if (input.budget.occupiedSequences.has(record.sequence)) continue
      const projected = eventRecordToProjectionEvent(record)
      const nextBytes = bytes + snapshotJsonBytes(projected) + (eventCount === 0 ? 0 : 1)
      if (
        eventCount + 1 > RESUME_SNAPSHOT_CAPACITY_EVENTS ||
        nextBytes > RESUME_SNAPSHOT_CAPACITY_BYTES
      ) {
        return { kind: "overflow" }
      }
      records.push(record)
      bytes = nextBytes
      eventCount += 1
    }
    const next = page.records.at(-1)?.sequence
    if (!page.hasMore) break
    if (next === undefined || next <= cursor) {
      return yield* new ChatStreamError({ message: "Chat event replay did not advance" })
    }
    cursor = next
  }
  return { kind: "complete", records }
})

const eventRecordToProjectionEvent = (record: SessionEventRecord): SnapshotProjectionEvent => ({
  ...record.event,
  session_id: record.sessionId,
  seq: record.sequence,
  timestamp: record.event.timestamp ?? DateTime.toEpochMillis(record.createdAt),
  replay: true
})

const resumeDeliveryToSse = (
  delivery: ChatEventDelivery,
  sessionId: string,
  appliedSequence: number
): Result.Result<SseEvent, void> => {
  if (delivery.kind === "record") {
    return delivery.record.sequence <= appliedSequence
      ? Result.fail(undefined)
      : Result.succeed(eventRecordToSse(delivery.record, delivery.replayed))
  }
  return Result.succeed(overflowEvent(sessionId, delivery.cursor, "follower_buffer"))
}

const parseSequence = (id: string | undefined): number | undefined => {
  if (id === undefined || id.trim().length === 0) return undefined
  const sequence = Number(id)
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : undefined
}

export const withKeepalives = <E>(
  source: Stream.Stream<SseEvent, E>,
  sessionId: string,
  initialSequence: number,
  interval: Duration.Input = KEEPALIVE_INTERVAL
): Stream.Stream<SseEvent, E> =>
  Stream.unwrap(
    Ref.make(initialSequence).pipe(
      Effect.map((lastSequence) =>
        Stream.merge(
          source.pipe(Stream.map((event) => ({ _tag: "Event" as const, event }))),
          Stream.fromSchedule(Schedule.spaced(interval)).pipe(
            Stream.map(() => ({ _tag: "Keepalive" as const }))
          ),
          { haltStrategy: "left" }
        ).pipe(
          Stream.mapEffect((delivery) => {
            if (delivery._tag === "Keepalive") {
              return Ref.get(lastSequence).pipe(
                Effect.map((sequence) => keepaliveEvent(sessionId, sequence))
              )
            }

            const sequence = parseSequence(delivery.event.id)
            return (
              sequence === undefined
                ? Effect.void
                : Ref.update(lastSequence, (current) => Math.max(current, sequence))
            ).pipe(Effect.as(delivery.event))
          })
        )
      )
    )
  )

const eventRecordToSse = (record: SessionEventRecord, replay = false): SseEvent => {
  const payload = {
    ...record.event,
    session_id: record.sessionId,
    seq: record.sequence,
    timestamp: record.event.timestamp ?? DateTime.toEpochMillis(record.createdAt),
    ...(replay ? { replay: true } : {})
  }
  return {
    _tag: "Event",
    id: String(record.sequence),
    event: record.event.type,
    data: JSON.stringify(payload)
  }
}

const snapshotEvent = (appliedSequence: number, data: string): SseEvent => ({
  _tag: "Event",
  id: String(appliedSequence),
  event: "stream_snapshot",
  data
})

const snapshotProtocolEvent = (
  sessionId: string,
  appliedSequence: number,
  history: HistoryResponse,
  activeEvents: ReadonlyArray<SnapshotProjectionEvent>
): StreamSnapshotEvent => ({
  type: "stream_snapshot",
  session_id: sessionId,
  seq: appliedSequence,
  snapshot: {
    version: 1,
    applied_seq: appliedSequence,
    history,
    active_events: activeEvents
  }
})

const liveEvent = (sessionId: string, caughtUpThrough: number): SseEvent =>
  protocolEventToSse({
    type: "stream_live",
    session_id: sessionId,
    seq: caughtUpThrough,
    caught_up_through: caughtUpThrough
  })

const overflowEvent = (
  sessionId: string,
  cursor: number,
  reason: StreamOverflowEvent["reason"]
): SseEvent =>
  protocolEventToSse({
    type: "stream_overflow",
    session_id: sessionId,
    seq: cursor,
    cursor,
    reason
  })

const protocolEventToSse = (
  event: StreamSnapshotEvent | StreamLiveEvent | StreamOverflowEvent
): SseEvent => ({
  _tag: "Event",
  id: String(event.seq),
  event: event.type,
  data: JSON.stringify(event)
})

const keepaliveEvent = (sessionId: string, sequence: number): SseEvent => ({
  _tag: "Event",
  id: String(sequence),
  event: "stream_keepalive",
  data: JSON.stringify({
    type: "stream_keepalive",
    session_id: sessionId,
    seq: sequence,
    latest_seq: sequence
  })
})

const toStreamError = (cause: unknown): ChatStreamError =>
  new ChatStreamError({
    message: errorMessage(cause, "Chat event stream failed"),
    cause
  })
