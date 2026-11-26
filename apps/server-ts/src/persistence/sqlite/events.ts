import { runActivityView } from "@arden-hq/protocol/chat"
import {
  appendInTransaction as appendJournalInTransaction,
  journalRecordsSql,
  journalStreamsSql,
  readHeadSequence,
  type JournalAppendResult,
  type JournalRuntime as GenericJournalRuntime
} from "@arden-hq/journal/effect"
import { DateTime, Effect, Schema, Stream } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import {
  ChatEventPageOverflow,
  ChatEventStore,
  ChatEventStoreError,
  type ChatActiveProjection,
  type ChatEventDelivery,
  type FollowChatEvents,
  type ReadChatActiveProjection,
  type ReadChatEventPage
} from "../events/store.js"
import { deltaEventBytes, makeDeltaWindow, type DeltaWindow } from "../events/delta-telemetry.js"
import {
  CommitEventBatchSchema,
  EventWatermarksSchema,
  isDurableDraft,
  type CommitEventBatch,
  type CommittedEventBatch,
  type EventPage,
  type EventWatermarks
} from "../events/model.js"
import type { PersistenceDeps } from "./deps.js"
import { UnitOfWork } from "../unit-of-work.js"
import { readLatestRunBoundary } from "./journal-run-boundary.js"
import { withContentAnchor } from "../events/content-anchor.js"
import {
  projectionBytes,
  reduceActiveProjection,
  terminalRunId,
  type ActiveProjectionState
} from "../events/active-projection.js"
import { isActiveRunStatus } from "@arden-hq/protocol/runs"
import {
  type EventAdmissionState,
  EventAdmissionRowSchema,
  eventAdmissionState,
  heldThrough,
  rejectedDraftIndex
} from "./event-admission.js"
import { decodeRecord, eventError, journalDraft, mapError } from "./event-records.js"

const DEFAULT_ACTIVE_PROJECTION_CAPACITY_BYTES = 4 * 1024 * 1024
const DEFAULT_ACTIVE_PROJECTION_GLOBAL_CAPACITY_BYTES = 16 * 1024 * 1024

export interface ChatEventStoreOptions {
  readonly activeProjectionCapacityBytes?: number
  readonly activeProjectionGlobalCapacityBytes?: number
}

interface WatermarkRow {
  readonly head_sequence: number
  readonly retained_from_sequence: number | null
  readonly checkpoint_seq: number
}

interface EventPayloadSizeRow {
  readonly sequence: number
  readonly payload_bytes: number
}

const observeDeltaVolume = Effect.fn("SqliteChatEventStore.observeDeltaVolume")(function* (
  deltas: DeltaWindow,
  committed: CommittedEventBatch
) {
  let events = 0
  let bytes = 0
  for (const record of committed.records) {
    const size = deltaEventBytes(record.event)
    if (size === undefined) continue
    events += 1
    bytes += size
  }
  if (events === 0) return
  const burst = deltas.observe({
    events,
    bytes,
    at: DateTime.toEpochMillis(yield* DateTime.now)
  })
  if (burst === undefined) return
  yield* Effect.logInfo("Chat delta stream burst", {
    sessionId: committed.sessionId,
    events: burst.events,
    bytes: burst.bytes,
    windowMs: burst.windowMs
  })
})

export const makeChatEventStore = (
  options: Pick<PersistenceDeps, "writer"> & {
    readonly journal: GenericJournalRuntime
  } & ChatEventStoreOptions
): ChatEventStore["Service"] => {
  const { writer, journal } = options
  const sql = writer.sql
  const reader = writer.reader
  const activeProjectionCapacityBytes =
    options.activeProjectionCapacityBytes ?? DEFAULT_ACTIVE_PROJECTION_CAPACITY_BYTES
  const activeProjectionGlobalCapacityBytes =
    options.activeProjectionGlobalCapacityBytes ?? DEFAULT_ACTIVE_PROJECTION_GLOBAL_CAPACITY_BYTES
  if (!Number.isSafeInteger(activeProjectionCapacityBytes) || activeProjectionCapacityBytes < 1) {
    throw new Error("activeProjectionCapacityBytes must be a positive safe integer")
  }
  if (
    !Number.isSafeInteger(activeProjectionGlobalCapacityBytes) ||
    activeProjectionGlobalCapacityBytes < 1
  ) {
    throw new Error("activeProjectionGlobalCapacityBytes must be a positive safe integer")
  }
  const activeProjections = new Map<string, ActiveProjectionState>()
  let activeProjectionBytes = 0
  const staged = new Map<string, number>()
  const published = new Map<string, number>()
  const trimFloors = new Map<string, number>()
  const deltaWindow = makeDeltaWindow()

  const storedEventAdmission = Effect.fn("SqliteChatEventStore.storedEventAdmission")(function* (
    sessionId: string
  ): Effect.fn.Return<EventAdmissionState | undefined, ChatEventStoreError> {
    const rows = yield* readLatestRunBoundary(sql, sessionId).pipe(
      Effect.mapError((cause) =>
        eventError("append", "Could not read the Chat event admission state", cause)
      )
    )
    const row = rows[0]
    if (row === undefined) return undefined
    const valid = yield* Schema.decodeUnknownEffect(EventAdmissionRowSchema)(row).pipe(
      Effect.mapError((cause) =>
        eventError("append", "Stored Chat event admission state is corrupt", cause)
      )
    )
    return valid.event_type === "RUN_STARTED"
      ? { kind: "active", runId: valid.run_id }
      : { kind: "terminal", runId: valid.run_id }
  })

  const appendInTransaction = Effect.fn("SqliteChatEventStore.appendInTransaction")(function* (
    batch: CommitEventBatch
  ): Effect.fn.Return<CommittedEventBatch, ChatEventStoreError, UnitOfWork> {
    const valid = yield* Schema.decodeUnknownEffect(CommitEventBatchSchema)(batch).pipe(
      Effect.mapError((cause) => eventError("append", "Invalid Chat event batch", cause))
    )
    const sessions = yield* sql<{ readonly session_id: string }>`
      SELECT session_id FROM sessions WHERE session_id = ${valid.sessionId}
    `.pipe(Effect.mapError((cause) => eventError("append", "Could not check Chat session", cause)))
    if (sessions.length === 0) return yield* eventError("append", "Chat session does not exist")
    const inMemoryAdmission = eventAdmissionState(activeProjections.get(valid.sessionId))
    let admission = inMemoryAdmission ?? (yield* storedEventAdmission(valid.sessionId))
    let rejectedIndex = rejectedDraftIndex(admission, valid.events)
    if (
      rejectedIndex === 0 &&
      admission?.kind === "active" &&
      admission.runId !== undefined &&
      valid.events[0]?.event.type === "RUN_STARTED"
    ) {
      const runs = yield* sql<{ readonly status: string }>`
        SELECT status FROM chat_runs WHERE run_id = ${admission.runId} LIMIT 1
      `.pipe(
        Effect.mapError((cause) =>
          eventError("append", "Could not check the active Chat run", cause)
        )
      )
      if (runs[0] !== undefined && !isActiveRunStatus(runs[0].status)) {
        admission = { kind: "terminal", runId: admission.runId }
        rejectedIndex = rejectedDraftIndex(admission, valid.events)
      }
    }
    if (rejectedIndex !== undefined) {
      return yield* eventError(
        "append",
        `Chat event at index ${rejectedIndex} targets a stale or terminal run`
      )
    }

    const active = activeProjections.get(valid.sessionId)
    const retained = active?.kind === "ready" ? active.records : []
    const drafts = yield* Effect.forEach(valid.events, (draft) =>
      journalDraft(withContentAnchor(draft.event, retained), draft.runId, isDurableDraft(draft))
    )
    const committed = yield* appendJournalInTransaction(sql, valid.sessionId, drafts).pipe(
      Effect.mapError(mapError("append", "Could not append Chat events"))
    )
    staged.set(valid.sessionId, Math.max(staged.get(valid.sessionId) ?? 0, committed.headSequence))
    const records = yield* Effect.forEach(committed.records, (record) =>
      decodeRecord(record, "read")
    )
    const batchCommitted = {
      sessionId: valid.sessionId,
      records,
      headSequence: committed.headSequence
    }
    const unit = yield* UnitOfWork
    yield* unit.afterCommit(publish(batchCommitted, committed))
    return batchCommitted
  })

  const setCheckpointInTransaction = Effect.fn("SqliteChatEventStore.setCheckpoint")(function* (
    sessionId: string,
    sequence: number
  ) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      return yield* eventError("checkpoint", "Checkpoint must be a non-negative safe integer")
    }
    const headSequence = yield* readHeadSequence(sql, sessionId).pipe(
      Effect.mapError(mapError("checkpoint", "Could not read the Chat event head"))
    )
    if (sequence > (headSequence ?? 0)) {
      return yield* eventError("checkpoint", "Checkpoint cannot exceed the Chat event head")
    }
    yield* sql`
      INSERT INTO session_event_checkpoints (session_id, checkpoint_seq)
      VALUES (${sessionId}, ${sequence})
      ON CONFLICT(session_id) DO UPDATE SET checkpoint_seq = MAX(
        session_event_checkpoints.checkpoint_seq,
        excluded.checkpoint_seq
      )
    `.pipe(
      Effect.mapError((cause) =>
        eventError("checkpoint", "Could not update Chat event checkpoint", cause)
      )
    )
  })

  const readWatermarks = Effect.fn("SqliteChatEventStore.watermarks")(function* (
    db: SqlClient.SqlClient,
    sessionId: string
  ): Effect.fn.Return<EventWatermarks, ChatEventStoreError> {
    const rows = yield* db<WatermarkRow>`
      SELECT
        COALESCE(stream.head_sequence, 0) AS head_sequence,
        stream.retained_from_sequence AS retained_from_sequence,
        COALESCE(checkpoint.checkpoint_seq, 0) AS checkpoint_seq
      FROM (SELECT ${sessionId} AS session_id) AS target
      LEFT JOIN ${journalStreamsSql(db)} AS stream ON stream.stream_id = target.session_id
      LEFT JOIN session_event_checkpoints AS checkpoint
        ON checkpoint.session_id = target.session_id
    `.pipe(
      Effect.mapError((cause) => eventError("read", "Could not read Chat event watermarks", cause))
    )
    return yield* Schema.decodeUnknownEffect(EventWatermarksSchema)({
      headSequence: rows[0]?.head_sequence,
      checkpointSequence: rows[0]?.checkpoint_seq,
      retainedFromSequence: rows[0]?.retained_from_sequence
    }).pipe(
      Effect.mapError((cause) =>
        eventError("read", "Stored Chat event watermarks are corrupt", cause)
      )
    )
  })

  const publish = Effect.fn("SqliteChatEventStore.publish")(function* (
    committed: CommittedEventBatch,
    journaled: JournalAppendResult
  ) {
    const terminal = [...committed.records]
      .reverse()
      .find((record) => terminalRunId(record) !== undefined)
    const checkpointSequence =
      terminal === undefined
        ? undefined
        : yield* readWatermarks(sql, committed.sessionId).pipe(
            Effect.map((state) => state.checkpointSequence),
            Effect.catch((cause) =>
              Effect.logWarning("Could not verify the terminal Chat projection checkpoint", {
                sessionId: committed.sessionId,
                cause
              }).pipe(Effect.as(undefined))
            )
          )
    const seeded =
      activeProjections.get(committed.sessionId) ??
      (yield* storedEventAdmission(committed.sessionId).pipe(
        Effect.map((stored): ActiveProjectionState | undefined =>
          stored?.kind === "active"
            ? { kind: "ready", runId: stored.runId, records: [], bytes: 0 }
            : undefined
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Could not seed the Chat projection admission state", {
            sessionId: committed.sessionId,
            cause
          }).pipe(Effect.as(undefined))
        )
      ))
    yield* Effect.sync(() => {
      let projection = seeded
      let trimFloor = trimFloors.get(committed.sessionId) ?? 0
      for (const [index, record] of committed.records.entries()) {
        const previous = projection
        const previousBytes = projectionBytes(projection)
        const otherProjectionBytes = activeProjectionBytes - previousBytes
        const availableBytes = Math.min(
          activeProjectionCapacityBytes,
          activeProjectionGlobalCapacityBytes - otherProjectionBytes
        )
        projection = reduceActiveProjection(
          projection,
          record,
          Math.max(0, availableBytes),
          checkpointSequence,
          index > 0
        )
        activeProjectionBytes = otherProjectionBytes + projectionBytes(projection)
        const restarted = record.event.type === "RUN_STARTED" && projection !== previous
        if (previous?.kind !== "terminal" && (projection?.kind === "terminal" || restarted)) {
          trimFloor = Math.max(trimFloor, heldThrough(previous))
        }
      }
      if (projection === undefined) activeProjections.delete(committed.sessionId)
      else activeProjections.set(committed.sessionId, projection)
      trimFloors.set(committed.sessionId, trimFloor)
      published.set(
        committed.sessionId,
        Math.max(published.get(committed.sessionId) ?? 0, committed.headSequence)
      )
    })
    yield* journal.notify(journaled)
    yield* observeDeltaVolume(deltaWindow, committed)
  })

  const append = Effect.fn("SqliteChatEventStore.append")(function* (batch: CommitEventBatch) {
    return yield* writer
      .transactInteractive(appendInTransaction(batch))
      .pipe(Effect.mapError(mapError("append", "Could not commit Chat events")))
  })

  const readPage = Effect.fn("SqliteChatEventStore.readPage")(function* (
    input: ReadChatEventPage
  ): Effect.fn.Return<EventPage, ChatEventStoreError | ChatEventPageOverflow> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 9_999) {
      return yield* eventError("read", "Event page limit must be an integer from 1 to 9999")
    }
    const capacityBytes = input.capacityBytes
    if (
      capacityBytes !== undefined &&
      (!Number.isSafeInteger(capacityBytes) || capacityBytes < 0)
    ) {
      return yield* eventError(
        "read",
        "Event page byte capacity must be a non-negative safe integer"
      )
    }
    const payloadSizes =
      capacityBytes === undefined
        ? undefined
        : yield* reader<EventPayloadSizeRow>`
          SELECT
            sequence,
            length(CAST(stream_id AS BLOB)) +
              length(CAST(event_type AS BLOB)) +
              length(CAST(data_json AS BLOB)) +
              length(CAST(attributes_json AS BLOB)) +
              length(CAST(created_at AS BLOB)) AS payload_bytes
          FROM ${journalRecordsSql(reader)}
          WHERE stream_id = ${input.sessionId}
            AND sequence > ${input.afterSequence}
            AND sequence <= ${input.throughSequence}
          ORDER BY sequence ASC
          LIMIT ${input.limit + 1}
        `.pipe(
            Effect.mapError((cause) =>
              eventError("read", "Could not measure Chat event page", cause)
            )
          )
    if (payloadSizes !== undefined && capacityBytes !== undefined) {
      let payloadBytes = 0
      for (const row of payloadSizes.slice(0, input.limit)) {
        payloadBytes += row.payload_bytes
        if (payloadBytes > capacityBytes) {
          return yield* new ChatEventPageOverflow({
            sequence: row.sequence,
            capacityBytes
          })
        }
      }
    }
    const readLimit =
      payloadSizes === undefined ? input.limit + 1 : Math.min(input.limit, payloadSizes.length)
    if (readLimit === 0) return { records: [], hasMore: false }
    const generic = yield* journal
      .readPage({
        streamId: input.sessionId,
        afterSequence: input.afterSequence,
        throughSequence: input.throughSequence,
        limit: readLimit
      })
      .pipe(Effect.mapError(mapError("read", "Could not read Chat event page")))
    const hasMore =
      payloadSizes === undefined ? generic.length > input.limit : payloadSizes.length > input.limit
    const records = yield* Effect.forEach(generic.slice(0, input.limit), (record) =>
      decodeRecord(record, "read")
    )
    return { records, hasMore }
  })

  const activeProjection = Effect.fn("SqliteChatEventStore.activeProjection")(function* (
    input: ReadChatActiveProjection
  ): Effect.fn.Return<ChatActiveProjection, ChatEventStoreError> {
    if (
      !Number.isSafeInteger(input.afterSequence) ||
      input.afterSequence < 0 ||
      !Number.isSafeInteger(input.throughSequence) ||
      input.throughSequence < input.afterSequence
    ) {
      return yield* eventError("read", "Active projection requires an ordered non-negative range")
    }
    const coverage = {
      publishedThrough: staged.has(input.sessionId)
        ? (published.get(input.sessionId) ?? 0)
        : input.throughSequence,
      trimFloor: trimFloors.get(input.sessionId) ?? 0
    }
    const current = activeProjections.get(input.sessionId)
    if (current === undefined) return { ...coverage, kind: "complete", records: [] }
    if (current.kind === "overflow") {
      return input.throughSequence > input.afterSequence
        ? { ...coverage, kind: "overflow", throughSequence: current.throughSequence }
        : { ...coverage, kind: "complete", records: [] }
    }
    if (current.kind === "terminal") return { ...coverage, kind: "complete", records: [] }
    const partial = current.records.find(
      ({ fromSequence, record }) =>
        fromSequence <= input.throughSequence &&
        record.sequence > input.afterSequence &&
        (fromSequence <= input.afterSequence || record.sequence > input.throughSequence)
    )
    if (partial !== undefined) {
      return { ...coverage, kind: "overflow", throughSequence: partial.record.sequence }
    }
    return {
      ...coverage,
      kind: "complete",
      records: current.records
        .map(({ record }) => record)
        .filter(
          (record) =>
            record.sequence > input.afterSequence && record.sequence <= input.throughSequence
        )
    }
  })

  const openFollow = Effect.fn("SqliteChatEventStore.openFollow")(function* (
    input: FollowChatEvents
  ) {
    const opened = yield* journal
      .openFollow({
        streamId: input.sessionId,
        ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
        ...(input.startAt === undefined ? {} : { startAt: input.startAt }),
        ...(input.replayFloor === undefined ? {} : { replayFloor: input.replayFloor })
      })
      .pipe(Effect.mapError(mapError("follow", "Could not open Chat event follower")))
    const stream = opened.stream.pipe(
      Stream.mapEffect((delivery): Effect.Effect<ChatEventDelivery, ChatEventStoreError> =>
        delivery.kind === "record"
          ? decodeRecord(delivery.record, "follow").pipe(
              Effect.map((record) => ({
                kind: "record" as const,
                record,
                replayed: delivery.replayed
              }))
            )
          : Effect.succeed(delivery)
      ),
      Stream.mapError(mapError("follow", "Could not follow Chat events"))
    )
    return { initialSequence: opened.initialSequence, stream }
  })

  return ChatEventStore.of({
    currentActivity: (sessionId, runId) => {
      const state = activeProjections.get(sessionId)
      return state?.kind !== "terminal" && state?.runId === runId
        ? runActivityView(state.activity)
        : undefined
    },
    append,
    appendInTransaction,
    setCheckpointInTransaction,
    watermarks: (sessionId) => readWatermarks(reader, sessionId),
    readPage,
    openFollow,
    activeProjection
  })
}
