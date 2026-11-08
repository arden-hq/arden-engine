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
import * as Sse from "effect/unstable/encoding/Sse"
import type { SessionEventRecord } from "../persistence/events/model.js"
import { ChatEventStore, type ChatEventDelivery } from "../persistence/events/store.js"
import { Persistence } from "../persistence/service.js"
import { boundConversationWindow } from "./history-budget.js"
import { encodeSnapshotJson, snapshotJsonBytes } from "./snapshot-encoding.js"
import { ChatHistory } from "./history.js"
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
  readonly stream: Stream.Stream<Sse.Event, ChatStreamError>
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

const openResumeStream = Effect.fn("ChatEventStream.openResume")(function* (
  options: OpenResumeStreamInput
): Effect.fn.Return<Stream.Stream<Sse.Event, ChatStreamError>, ChatStreamError, Scope.Scope> {
  const opened = yield* options.events
    .openFollow({
      sessionId: options.input.sessionId,
      startAt: "latest"
    })
    .pipe(Effect.mapError(toStreamError))
  const followerMs = options.timer?.mark("resume_follower")
  const queuedAt = options.timer?.now()
  const capture = captureResumeProjection(
    options.events,
    options.history,
    options.input.sessionId,
    queuedAt,
    options.timer
  )
  const projection = yield* options.persistence
    .consistentRead(
      options.resumeId === undefined
        ? capture
        : capture.pipe(Effect.annotateLogs("resume_id", options.resumeId))
    )
    .pipe(Effect.mapError(toStreamError))
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

const boundedHistoryWindow = Effect.fn("ChatEventStream.boundedHistoryWindow")(function* (
  history: ChatHistory["Service"],
  sessionId: string
): Effect.fn.Return<HistoryResponse, unknown> {
  const snapshot = yield* history.get({ sessionId, limit: RESUME_HISTORY_WINDOW_LIMIT })
  return boundConversationWindow(snapshot, RESUME_HISTORY_CAPACITY_BYTES)
})

const captureResumeProjection = Effect.fn("ChatEventStream.captureResumeProjection")(function* (
  events: ChatEventStore["Service"],
  history: ChatHistory["Service"],
  sessionId: string,
  queuedAt: number | undefined,
  timer: ChatOpenTimer | undefined
): Effect.fn.Return<ResumeProjection, unknown> {
  const captureStartedAt = timer?.now()
  const queueWaitMs = timer?.mark("resume_capture_queue")
  const report = (result: string, fields: Readonly<Record<string, number | undefined>>) =>
    timer === undefined || !chatOpenTracingEnabled()
      ? Effect.void
      : logChatOpenTiming("chat.resume_capture_timing", {
          queueWaitMs:
            queuedAt === undefined || captureStartedAt === undefined
              ? queueWaitMs
              : Math.round((captureStartedAt - queuedAt) * 100) / 100,
          ...fields,
          totalMs: timer.total(),
          result
        })
  const snapshot = yield* boundedHistoryWindow(history, sessionId)
  const historyMs = timer?.mark("resume_history")
  const checkpointSequence = snapshot.runtime.checkpoint_seq
  const appliedSequence = snapshot.runtime.latest_event_seq
  const active = yield* events.activeProjection({
    sessionId,
    afterSequence: checkpointSequence,
    throughSequence: appliedSequence
  })
  const activeProjectionMs = timer?.mark("resume_active_projection")
  if (active.kind === "overflow") {
    yield* report("active_overflow", { historyMs, activeProjectionMs })
    return { kind: "overflow", safeCursor: checkpointSequence }
  }

  const projectedActive = active.records.map(eventRecordToProjectionEvent)
  const occupiedSequences = new Set(active.records.map((record) => record.sequence))
  const initialEncoded = encodeSnapshotJson(
    snapshotProtocolEvent(sessionId, appliedSequence, snapshot, projectedActive)
  )
  const initialBytes = initialEncoded.bytes
  const initialProjectionMs = timer?.mark("resume_initial_projection")
  if (
    projectedActive.length > RESUME_SNAPSHOT_CAPACITY_EVENTS ||
    initialBytes > RESUME_SNAPSHOT_CAPACITY_BYTES
  ) {
    yield* report("initial_budget_overflow", {
      historyMs,
      activeProjectionMs,
      initialProjectionMs,
      activeEventCount: active.records.length,
      initialSnapshotBytes: initialBytes
    })
    return { kind: "overflow", safeCursor: checkpointSequence }
  }

  const durable = yield* readDurableRange({
    events,
    sessionId,
    afterSequence: checkpointSequence,
    throughSequence: appliedSequence,
    budget: {
      bytes: initialBytes,
      eventCount: projectedActive.length,
      occupiedSequences
    }
  })
  const durableRangeMs = timer?.mark("resume_durable_range")
  if (durable.kind === "overflow") {
    yield* report("durable_overflow", {
      historyMs,
      activeProjectionMs,
      initialProjectionMs,
      durableRangeMs,
      activeEventCount: active.records.length,
      initialSnapshotBytes: initialBytes
    })
    return { kind: "overflow", safeCursor: checkpointSequence }
  }
  const hasNewDurable = durable.records.some((record) => !occupiedSequences.has(record.sequence))
  if (!hasNewDurable) {
    yield* report("complete", {
      historyMs,
      activeProjectionMs,
      initialProjectionMs,
      durableRangeMs,
      finalProjectionMs: timer?.mark("resume_final_projection"),
      activeEventCount: projectedActive.length,
      finalSnapshotBytes: initialBytes
    })
    return { kind: "complete", appliedSequence, snapshotData: initialEncoded.data }
  }
  const bySequence = new Map<number, SessionEventRecord>()
  for (const record of durable.records) bySequence.set(record.sequence, record)
  for (const record of active.records) bySequence.set(record.sequence, record)
  const activeEvents = [...bySequence.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .map(eventRecordToProjectionEvent)
  const encoded = encodeSnapshotJson(
    snapshotProtocolEvent(sessionId, appliedSequence, snapshot, activeEvents)
  )
  const finalBytes = encoded.bytes
  if (
    activeEvents.length > RESUME_SNAPSHOT_CAPACITY_EVENTS ||
    finalBytes > RESUME_SNAPSHOT_CAPACITY_BYTES
  ) {
    yield* report("final_budget_overflow", {
      historyMs,
      activeProjectionMs,
      initialProjectionMs,
      durableRangeMs,
      activeEventCount: activeEvents.length
    })
    return { kind: "overflow", safeCursor: checkpointSequence }
  }
  yield* report("complete", {
    historyMs,
    activeProjectionMs,
    initialProjectionMs,
    durableRangeMs,
    finalProjectionMs: timer?.mark("resume_final_projection"),
    activeEventCount: activeEvents.length,
    finalSnapshotBytes: finalBytes
  })
  return { kind: "complete", appliedSequence, snapshotData: encoded.data }
})

const readDurableRange = Effect.fn("ChatEventStream.readDurableRange")(function* (input: {
  readonly events: ChatEventStore["Service"]
  readonly sessionId: string
  readonly afterSequence: number
  readonly throughSequence: number
  readonly budget: ResumeSnapshotBudget
}): Effect.fn.Return<DurableResumeRange, unknown> {
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
): Result.Result<Sse.Event, void> => {
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
  source: Stream.Stream<Sse.Event, E>,
  sessionId: string,
  initialSequence: number,
  interval: Duration.Input = KEEPALIVE_INTERVAL
): Stream.Stream<Sse.Event, E> =>
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

const eventRecordToSse = (record: SessionEventRecord, replay = false): Sse.Event => {
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

const snapshotEvent = (appliedSequence: number, data: string): Sse.Event => ({
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

const liveEvent = (sessionId: string, caughtUpThrough: number): Sse.Event =>
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
): Sse.Event =>
  protocolEventToSse({
    type: "stream_overflow",
    session_id: sessionId,
    seq: cursor,
    cursor,
    reason
  })

const protocolEventToSse = (
  event: StreamSnapshotEvent | StreamLiveEvent | StreamOverflowEvent
): Sse.Event => ({
  _tag: "Event",
  id: String(event.seq),
  event: event.type,
  data: JSON.stringify(event)
})

const keepaliveEvent = (sessionId: string, sequence: number): Sse.Event => ({
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
