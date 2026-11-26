import { JOURNAL_DELIVERY } from "@arden-hq/journal/effect"
import { ACTIVE_PROJECTION } from "../persistence/events/active-projection.js"
import type { SnapshotProjectionEvent } from "@arden-hq/protocol"
import { HISTORY_WINDOW } from "@arden-hq/protocol/chat"
import { randomUUID } from "node:crypto"
import {
  Context,
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
import {
  chatEventFrame,
  eventRecordToSse,
  keepaliveEvent,
  liveEvent,
  overflowEvent,
  snapshotEvent,
  snapshotProtocolEvent
} from "./event-frames.js"

const KEEPALIVE_INTERVAL = "5 seconds"
const RESUME_SNAPSHOT_CAPACITY_BYTES = 8 * 1024 * 1024
const RESUME_SNAPSHOT_CAPACITY_EVENTS = 4_096
const RESUME_REPLAY_PAGE_SIZE = 1_000
const RESUME_HISTORY_CAPACITY_BYTES = RESUME_SNAPSHOT_CAPACITY_BYTES / 2
const RESUME_HISTORY = { limit: 100, window: { kind: HISTORY_WINDOW.latest } } as const

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

const RESUME_READ_KIND = { complete: "complete", overflow: "overflow" } as const

type ResumeProjection =
  | {
      readonly kind: typeof RESUME_READ_KIND.complete
      readonly appliedSequence: number
      readonly snapshotData: string
    }
  | {
      readonly kind: typeof RESUME_READ_KIND.overflow
      readonly safeCursor: number
    }

type DurableResumeRange =
  | {
      readonly kind: typeof RESUME_READ_KIND.complete
      readonly records: ReadonlyArray<SessionEventRecord>
    }
  | {
      readonly kind: typeof RESUME_READ_KIND.overflow
    }

interface ResumeSnapshotBudget {
  readonly bytes: number
  readonly eventCount: number
  readonly occupiedSequences: ReadonlySet<number>
}

type ResumeRead =
  | {
      readonly kind: typeof RESUME_READ_KIND.overflow
      readonly result: "active_overflow" | "initial_budget_overflow" | "durable_overflow"
      readonly checkpointSequence: number
      readonly activeEventCount: number
      readonly initialSnapshotBytes: number | undefined
    }
  | {
      readonly kind: typeof RESUME_READ_KIND.complete
      readonly history: HistoryRead
      readonly appliedSequence: number
      readonly checkpointSequence: number
      readonly active: ReadonlyArray<SessionEventRecord>
      readonly durable: ReadonlyArray<SessionEventRecord>
    }

const COVERAGE = { checked: "checked", trusted: "trusted" } as const

const STREAM_DELIVERY = { Event: "Event", Keepalive: "Keepalive" } as const

type StreamTag = (typeof STREAM_DELIVERY)[keyof typeof STREAM_DELIVERY]
const isKeepalive = <D extends { readonly _tag: StreamTag }>(
  delivery: D
): delivery is Extract<D, { readonly _tag: typeof STREAM_DELIVERY.Keepalive }> =>
  delivery._tag === STREAM_DELIVERY.Keepalive

type ResumeCoverage = (typeof COVERAGE)[keyof typeof COVERAGE]

class ResumeSnapshotStale extends Schema.TaggedError<ResumeSnapshotStale>()("ResumeSnapshotStale", {
  appliedSequence: Schema.Int,
  checkpointSequence: Schema.Int,
  publishedThrough: Schema.Int,
  trimFloor: Schema.Int
}) {}

const projectionCoversSnapshot = (
  projection: { readonly publishedThrough: number; readonly trimFloor: number },
  snapshot: { readonly appliedSequence: number; readonly checkpointSequence: number }
): boolean =>
  projection.publishedThrough >= snapshot.appliedSequence &&
  projection.trimFloor <= snapshot.checkpointSequence

const resumeSnapshotRetry = {
  times: 3,
  schedule: Schedule.exponential("5 millis"),
  while: (error: unknown) => error instanceof ResumeSnapshotStale
}

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

  if (projection.kind === ACTIVE_PROJECTION.overflow) {
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
  if (captured.kind === RESUME_READ_KIND.overflow) {
    yield* report(captured.result, {
      activeEventCount: captured.activeEventCount,
      initialSnapshotBytes: captured.initialSnapshotBytes
    })
    return { kind: RESUME_READ_KIND.overflow, safeCursor: captured.checkpointSequence }
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
    return { kind: RESUME_READ_KIND.overflow, safeCursor: captured.checkpointSequence }
  }
  yield* report("complete", {
    finalProjectionMs: timer?.mark("resume_final_projection"),
    activeEventCount: activeEvents.length,
    finalSnapshotBytes: encoded.bytes
  })
  return {
    kind: RESUME_READ_KIND.complete,
    appliedSequence: captured.appliedSequence,
    snapshotData: encoded.data
  }
})

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
  timer?.mark("resume_capture_queue")
  const loaded = yield* input.history.read({ sessionId, ...RESUME_HISTORY })
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
    input.coverage === COVERAGE.checked &&
    !projectionCoversSnapshot(active, { appliedSequence, checkpointSequence })
  ) {
    return yield* new ResumeSnapshotStale({
      appliedSequence,
      checkpointSequence,
      publishedThrough: active.publishedThrough,
      trimFloor: active.trimFloor
    })
  }
  if (active.kind === ACTIVE_PROJECTION.overflow) {
    return {
      kind: RESUME_READ_KIND.overflow,
      result: "active_overflow",
      checkpointSequence,
      activeEventCount: 0,
      initialSnapshotBytes: undefined
    }
  }

  const projectedActive = active.records.map(eventRecordToProjectionEvent)
  const initialBytes = snapshotJsonBytes(history) + snapshotJsonBytes(projectedActive)
  timer?.mark("resume_initial_projection")
  if (
    projectedActive.length > RESUME_SNAPSHOT_CAPACITY_EVENTS ||
    initialBytes > RESUME_SNAPSHOT_CAPACITY_BYTES
  ) {
    return {
      kind: RESUME_READ_KIND.overflow,
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
  if (durable.kind === RESUME_READ_KIND.overflow) {
    return {
      kind: RESUME_READ_KIND.overflow,
      result: "durable_overflow",
      checkpointSequence,
      activeEventCount: active.records.length,
      initialSnapshotBytes: initialBytes
    }
  }
  return {
    kind: RESUME_READ_KIND.complete,
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
    if (page === undefined) return { kind: RESUME_READ_KIND.overflow }
    for (const record of page.records) {
      if (input.budget.occupiedSequences.has(record.sequence)) continue
      const projected = eventRecordToProjectionEvent(record)
      const nextBytes = bytes + snapshotJsonBytes(projected) + (eventCount === 0 ? 0 : 1)
      if (
        eventCount + 1 > RESUME_SNAPSHOT_CAPACITY_EVENTS ||
        nextBytes > RESUME_SNAPSHOT_CAPACITY_BYTES
      ) {
        return { kind: RESUME_READ_KIND.overflow }
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
  return { kind: RESUME_READ_KIND.complete, records }
})

const eventRecordToProjectionEvent = (record: SessionEventRecord): SnapshotProjectionEvent => ({
  ...record.event,
  ...chatEventFrame(record),
  replay: true
})

const resumeDeliveryToSse = (
  delivery: ChatEventDelivery,
  sessionId: string,
  appliedSequence: number
): Result.Result<SseEvent, void> => {
  if (delivery.kind === JOURNAL_DELIVERY.record) {
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
          source.pipe(Stream.map((event) => ({ _tag: STREAM_DELIVERY.Event, event }))),
          Stream.fromSchedule(Schedule.spaced(interval)).pipe(
            Stream.map(() => ({ _tag: STREAM_DELIVERY.Keepalive }))
          ),
          { haltStrategy: "left" }
        ).pipe(
          Stream.mapEffect((delivery) => {
            if (isKeepalive(delivery)) {
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

const toStreamError = (cause: unknown): ChatStreamError =>
  new ChatStreamError({
    message: errorMessage(cause, "Chat event stream failed"),
    cause
  })
