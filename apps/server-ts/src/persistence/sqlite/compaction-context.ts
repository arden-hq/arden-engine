import { AUTOMATION_CONTEXT_MODE } from "@arden-hq/protocol/automations"
import { STORE_REASON } from "../errors.js"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  CONTEXT_COMPACTION_PURPOSE,
  ContextCompactionStoreError,
  type ContextCompactionOperation,
  type ContextCompactionSnapshotInput
} from "../compaction/store.js"
import { JsonObjectSchema, type JsonObject } from "../json.js"
import { type StoredMessageEnvelope, type TranscriptMessageDraft } from "../transcript/model.js"
import { decodeJson } from "./json.js"
import { ActiveContextError, loadActiveContext } from "./active-context.js"
import { assertIdleCompaction } from "./compaction-idle.js"
import { ActiveRunStatusSchema } from "@arden-hq/protocol/effect/chat"
import { activeRunStatusList } from "./status-sets.js"

interface SessionRow {
  readonly session_id: string
  readonly public_ref: string
  readonly source_ref: string | null
  readonly metadata: string | null
  readonly chat_model: string | null
  readonly context_generation: number
  readonly active_message_count: number
  readonly context_from_seq: number | null
  readonly context_head_seq: number | null
}

interface ActiveRunRow {
  readonly run_id: string
  readonly turn_id: string | null
  readonly status: string
  readonly model_id: string | null
  readonly reasoning_effort: string | null
  readonly context_mode: string | null
}

interface LoadedContext {
  readonly row: SessionRow
  readonly metadata: JsonObject
  readonly run: ActiveRunRow | null
}

export const contextVersion = (row: SessionRow): string =>
  [
    row.context_generation,
    row.context_from_seq ?? "array",
    row.context_head_seq ?? "",
    row.active_message_count
  ].join(":")

export const loadMessages = Effect.fn("SqliteContextCompactionStore.loadMessages")(function* (
  sql: SqlClient.SqlClient,
  input: ContextCompactionSnapshotInput,
  operation: ContextCompactionOperation
): Effect.fn.Return<ReadonlyArray<StoredMessageEnvelope>, ContextCompactionStoreError> {
  return yield* loadActiveContext(sql, input.sessionId).pipe(
    Effect.mapError((cause) =>
      cause instanceof ActiveContextError
        ? error(
            operation,
            cause.reason === STORE_REASON.corrupt ? STORE_REASON.corrupt : STORE_REASON.invalid,
            cause.message,
            {
              ...input,
              cause
            }
          )
        : error(operation, "storage", "Could not load the active context", { ...input, cause })
    )
  )
})

export const error = (
  operation: ContextCompactionOperation,
  reason: ContextCompactionStoreError["reason"],
  message: string,
  fields: { readonly sessionId?: string; readonly runId?: string; readonly cause?: unknown } = {}
): ContextCompactionStoreError =>
  new ContextCompactionStoreError({
    operation,
    reason,
    message,
    ...(fields.sessionId === undefined ? {} : { sessionId: fields.sessionId }),
    ...(fields.runId === undefined ? {} : { runId: fields.runId }),
    ...(fields.cause === undefined ? {} : { cause: fields.cause })
  })

export type ContextCompactionErrorMapper = (cause: unknown) => ContextCompactionStoreError

export const mapStorage =
  (
    operation: ContextCompactionOperation,
    message: string,
    fields: { readonly sessionId?: string; readonly runId?: string } = {}
  ): ContextCompactionErrorMapper =>
  (cause: unknown): ContextCompactionStoreError =>
    cause instanceof ContextCompactionStoreError
      ? cause
      : error(operation, "storage", message, { ...fields, cause })

export const invalidInput =
  (operation: ContextCompactionOperation): ContextCompactionErrorMapper =>
  (cause: unknown) =>
    error(operation, "invalid", "Invalid compaction input", { cause })

export const load = Effect.fn("SqliteContextCompactionStore.load")(function* (
  sql: SqlClient.SqlClient,
  input: ContextCompactionSnapshotInput,
  operation: ContextCompactionOperation
): Effect.fn.Return<LoadedContext, ContextCompactionStoreError> {
  if (input.purpose === CONTEXT_COMPACTION_PURPOSE.idle) {
    if (input.runId !== undefined)
      return yield* error(operation, "invalid", "Idle compaction cannot own a run", input)
    yield* assertIdleCompaction(sql, input.sessionId, operation)
  }
  const rows = yield* sql<SessionRow>`
    SELECT session_id, public_ref, metadata, chat_model,
           (SELECT public_ref FROM sessions AS source
            WHERE source.session_id = COALESCE(
              json_extract(sessions.metadata, '$.fork_origin.sourceSessionId'),
              sessions.parent_session_id
            )) AS source_ref,
           context_generation, active_message_count, context_from_seq, context_head_seq
    FROM sessions
    WHERE session_id = ${input.sessionId} AND archived_at IS NULL
    LIMIT 1
  `.pipe(Effect.mapError(mapStorage(operation, "Could not load compaction Session", input)))
  const row = rows[0]
  if (row === undefined) {
    return yield* error(operation, "not_found", "Active Session was not found", input)
  }
  const generation = yield* Schema.decodeUnknownEffect(Schema.Natural)(row.context_generation).pipe(
    Effect.mapError((cause) =>
      error(operation, "corrupt", "Session context generation is corrupt", {
        ...input,
        cause
      })
    )
  )
  const count = yield* Schema.decodeUnknownEffect(Schema.Natural)(row.active_message_count).pipe(
    Effect.mapError((cause) =>
      error(operation, "corrupt", "Session active message count is corrupt", {
        ...input,
        cause
      })
    )
  )
  const metadata = yield* decodeJson(JsonObjectSchema, row.metadata ?? "{}").pipe(
    Effect.mapError((cause) =>
      error(operation, "corrupt", "Session metadata is corrupt", {
        ...input,
        cause
      })
    )
  )

  const activeRows = yield* sql<ActiveRunRow>`
    SELECT run_id, json_extract(metadata_json, '$.turn_id') AS turn_id,
           status, model_id, reasoning_effort,
           json_extract(metadata_json, '$.automation.context_mode') AS context_mode
    FROM chat_runs
    WHERE session_id = ${input.sessionId}
      AND status IN ${activeRunStatusList}
    ORDER BY updated_at DESC, started_at DESC, run_id DESC
  `.pipe(Effect.mapError(mapStorage(operation, "Could not inspect active Chat runs", input)))
  if (activeRows.length > 1) {
    return yield* error(operation, "corrupt", "Session has multiple active Chat runs", input)
  }
  let active = activeRows[0] ?? null
  if (input.runId === undefined && active !== null) {
    return yield* error(operation, "conflict", "Manual compaction requires an idle Session", {
      sessionId: input.sessionId,
      runId: active.run_id
    })
  }
  if (input.runId !== undefined && active?.run_id !== input.runId) {
    return yield* error(
      operation,
      "conflict",
      "Automatic compaction requires the matching active run",
      input
    )
  }
  if (input.runId !== undefined && active?.context_mode === AUTOMATION_CONTEXT_MODE.fresh) {
    return yield* error(
      operation,
      "conflict",
      "Automatic compaction requires a run that carries the Session context",
      input
    )
  }
  if (active !== null) {
    const activeRun = active
    yield* Schema.decodeUnknownEffect(ActiveRunStatusSchema)(activeRun.status).pipe(
      Effect.mapError((cause) =>
        error(operation, "corrupt", "Active Chat run status is corrupt", {
          sessionId: input.sessionId,
          runId: activeRun.run_id,
          cause
        })
      )
    )
    const turnId = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(activeRun.turn_id).pipe(
      Effect.mapError((cause) =>
        error(operation, "corrupt", "Active Chat run has no durable turn id", {
          sessionId: input.sessionId,
          runId: activeRun.run_id,
          cause
        })
      )
    )
    active = { ...activeRun, turn_id: turnId }
  }

  return {
    row: { ...row, context_generation: generation, active_message_count: count },
    metadata,
    run: active
  }
})

export const selectTail = Effect.fn("SqliteContextCompactionStore.selectTail")(function* (
  current: ReadonlyArray<StoredMessageEnvelope>,
  handoff: TranscriptMessageDraft,
  operation: ContextCompactionOperation,
  sessionId: string,
  runId?: string
): Effect.fn.Return<ReadonlyArray<StoredMessageEnvelope>, ContextCompactionStoreError> {
  const receipt = handoff.compaction
  if (receipt === null) {
    return yield* error(operation, "invalid", "Compaction commit requires a Session handoff", {
      sessionId,
      ...(runId === undefined ? {} : { runId })
    })
  }
  const ids = receipt.preservedTailIds
  const boundary =
    ids.length === 0
      ? current.length
      : current.findIndex((message) => message.message_id === ids[0])
  if (boundary < 0) {
    return yield* error(
      operation,
      "invalid",
      "Preserved compaction tail is not in the active projection",
      {
        sessionId,
        ...(runId === undefined ? {} : { runId })
      }
    )
  }
  const tail = current.slice(boundary)
  if (
    tail.length !== ids.length ||
    tail.some((message, index) => message.message_id !== ids[index])
  ) {
    return yield* error(
      operation,
      "invalid",
      "Preserved compaction ids must be an exact active suffix",
      {
        sessionId,
        ...(runId === undefined ? {} : { runId })
      }
    )
  }
  if (boundary === 0) {
    return yield* error(operation, "invalid", "Compaction must replace a non-empty active prefix", {
      sessionId,
      ...(runId === undefined ? {} : { runId })
    })
  }
  if (receipt.messagesBefore !== current.length || receipt.messagesAfter !== tail.length + 1) {
    return yield* error(
      operation,
      "invalid",
      "Compaction receipt counts do not match its projection",
      {
        sessionId,
        ...(runId === undefined ? {} : { runId })
      }
    )
  }
  if (receipt.messagesAfter >= receipt.messagesBefore) {
    return yield* error(operation, "invalid", "Compaction must reduce the active message count", {
      sessionId,
      ...(runId === undefined ? {} : { runId })
    })
  }
  if (receipt.messageStart !== undefined && receipt.messageStart !== 0) {
    return yield* error(operation, "invalid", "Compaction must replace the active prefix", {
      sessionId,
      ...(runId === undefined ? {} : { runId })
    })
  }
  if (receipt.messageEnd !== undefined && receipt.messageEnd !== boundary) {
    return yield* error(
      operation,
      "invalid",
      "Compaction boundary does not match its preserved tail",
      {
        sessionId,
        ...(runId === undefined ? {} : { runId })
      }
    )
  }
  if (receipt.messageStartId !== undefined && receipt.messageStartId !== current[0]?.message_id) {
    return yield* error(
      operation,
      "invalid",
      "Compaction start id does not match the active prefix",
      {
        sessionId,
        ...(runId === undefined ? {} : { runId })
      }
    )
  }
  if (
    receipt.messageEndId !== undefined &&
    receipt.messageEndId !== current[boundary - 1]?.message_id
  ) {
    return yield* error(
      operation,
      "invalid",
      "Compaction end id does not match the active prefix",
      {
        sessionId,
        ...(runId === undefined ? {} : { runId })
      }
    )
  }
  return tail
})
