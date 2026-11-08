import { DateTime, Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  ContextCompactionStore,
  ContextCompactionStoreError,
  type ContextCompactionCommitInput,
  type ContextCompactionCommitResult,
  type ContextCompactionMeasure,
  type ContextCompactionOperation,
  type ContextCompactionSnapshot,
  type ContextCompactionSnapshotInput
} from "../compaction/store.js"
import { JsonObjectSchema, type JsonObject } from "../json.js"
import {
  StoredMessageEnvelopeSchema,
  TranscriptMessageDraftSchema,
  type StoredMessageEnvelope,
  type TranscriptMessageDraft
} from "../transcript/model.js"
import { decodeJson, decodeWith, encodeJson } from "./json.js"
import { appendSessionTurn, currentSessionTurnId } from "./turns.js"
import { ActiveContextError, loadActiveContext, replaceActiveContext } from "./active-context.js"
import type { PersistenceDeps } from "./deps.js"
import { assertIdleCompaction } from "./compaction-idle.js"
import { ActiveRunStatusSchema } from "@arden-hq/protocol/effect/chat"
import { activeRunStatusList } from "./status-sets.js"
import { moveMemoryCaptureContextInTransaction } from "./run-sidecar-mutations.js"

const snapshotInputSchema = Schema.Struct({
  purpose: Schema.optionalKey(Schema.Literal("idle")),
  sessionId: Schema.NonEmptyString,
  runId: Schema.optionalKey(Schema.NonEmptyString)
})

const commitInputSchema = Schema.Struct({
  purpose: Schema.optionalKey(Schema.Literal("idle")),
  sessionId: Schema.NonEmptyString,
  runId: Schema.optionalKey(Schema.NonEmptyString),
  expectedContextGeneration: Schema.Natural,
  expectedContextVersion: Schema.NonEmptyString,
  handoff: TranscriptMessageDraftSchema
})

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

const contextVersion = (row: SessionRow): string =>
  [
    row.context_generation,
    row.context_from_seq ?? "array",
    row.context_head_seq ?? "",
    row.active_message_count
  ].join(":")

const loadMessages = Effect.fn("SqliteContextCompactionStore.loadMessages")(function* (
  sql: SqlClient.SqlClient,
  input: ContextCompactionSnapshotInput,
  operation: ContextCompactionOperation
): Effect.fn.Return<ReadonlyArray<StoredMessageEnvelope>, ContextCompactionStoreError> {
  return yield* loadActiveContext(sql, input.sessionId).pipe(
    Effect.mapError((cause) =>
      cause instanceof ActiveContextError
        ? error(operation, cause.reason === "corrupt" ? "corrupt" : "invalid", cause.message, {
            ...input,
            cause
          })
        : error(operation, "storage", "Could not load the active context", { ...input, cause })
    )
  )
})

const error = (
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

const mapStorage =
  (
    operation: ContextCompactionOperation,
    message: string,
    fields: { readonly sessionId?: string; readonly runId?: string } = {}
  ) =>
  (cause: unknown): ContextCompactionStoreError =>
    cause instanceof ContextCompactionStoreError
      ? cause
      : error(operation, "storage", message, { ...fields, cause })

const invalidInput = (operation: ContextCompactionOperation) => (cause: unknown) =>
  error(operation, "invalid", "Invalid compaction input", { cause })

const load = Effect.fn("SqliteContextCompactionStore.load")(function* (
  sql: SqlClient.SqlClient,
  input: ContextCompactionSnapshotInput,
  operation: ContextCompactionOperation
): Effect.fn.Return<LoadedContext, ContextCompactionStoreError> {
  if (input.purpose === "idle") {
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
  if (input.runId !== undefined && active?.context_mode === "fresh") {
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

const selectTail = Effect.fn("SqliteContextCompactionStore.selectTail")(function* (
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

export const makeContextCompactionStore = ({
  writer,
  reader,
  sessionEvents,
  chatEvents
}: Pick<
  PersistenceDeps,
  "writer" | "reader" | "sessionEvents" | "chatEvents"
>): ContextCompactionStore["Service"] => {
  const sql = writer.sql
  const consistent = <A>(
    operation: ContextCompactionOperation,
    input: ContextCompactionSnapshotInput,
    read: Effect.Effect<A, ContextCompactionStoreError>
  ) =>
    writer
      .snapshot(read)
      .pipe(Effect.mapError(mapStorage(operation, "Could not read the compaction Session", input)))
  const snapshot = Effect.fn("SqliteContextCompactionStore.snapshot")(function* (
    input: ContextCompactionSnapshotInput
  ): Effect.fn.Return<ContextCompactionSnapshot, ContextCompactionStoreError> {
    const valid = yield* decodeWith(snapshotInputSchema, input, invalidInput("snapshot"))
    return yield* consistent(
      "snapshot",
      valid,
      Effect.gen(function* () {
        const loaded = yield* load(reader, valid, "snapshot")
        const run = loaded.run
        return {
          sessionId: loaded.row.session_id,
          sessionRef: loaded.row.public_ref,
          sourceSessionRef: loaded.row.source_ref ?? undefined,
          runId: run?.run_id ?? null,
          modelId: run?.model_id ?? loaded.row.chat_model,
          reasoningEffort: run?.reasoning_effort ?? null,
          messages: yield* loadMessages(reader, valid, "snapshot"),
          contextVersion: contextVersion(loaded.row),
          metadata: loaded.metadata,
          contextGeneration: loaded.row.context_generation
        }
      })
    )
  })

  const measure = Effect.fn("SqliteContextCompactionStore.measure")(function* (
    input: ContextCompactionSnapshotInput
  ): Effect.fn.Return<ContextCompactionMeasure, ContextCompactionStoreError> {
    const valid = yield* decodeWith(snapshotInputSchema, input, invalidInput("measure"))
    const loaded = yield* load(reader, valid, "measure")
    return {
      sessionId: loaded.row.session_id,
      runId: loaded.run?.run_id ?? null,
      modelId: loaded.run?.model_id ?? loaded.row.chat_model,
      messageCount: loaded.row.active_message_count,
      metadata: loaded.metadata
    }
  })

  const commit = Effect.fn("SqliteContextCompactionStore.commit")(function* (
    input: ContextCompactionCommitInput
  ): Effect.fn.Return<ContextCompactionCommitResult, ContextCompactionStoreError> {
    const valid = yield* decodeWith(commitInputSchema, input, invalidInput("commit"))
    const receipt = valid.handoff.compaction
    if (receipt === null) {
      return yield* error(
        "commit",
        "invalid",
        "Compaction commit requires a Session handoff",
        valid
      )
    }
    const rehydrationJson =
      receipt.rehydrationState === null
        ? null
        : yield* encodeJson(JsonObjectSchema, receipt.rehydrationState).pipe(
            Effect.mapError((cause) =>
              error("commit", "invalid", "Compaction rehydration cannot be encoded", {
                sessionId: valid.sessionId,
                ...(valid.runId === undefined ? {} : { runId: valid.runId }),
                cause
              })
            )
          )
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const loaded = yield* load(sql, valid, "commit")
          if (
            loaded.row.context_generation !== valid.expectedContextGeneration ||
            contextVersion(loaded.row) !== valid.expectedContextVersion
          ) {
            return yield* error(
              "commit",
              "conflict",
              "Session context changed while compaction was prepared",
              valid
            )
          }
          const current = yield* loadMessages(sql, valid, "commit")
          const tail = yield* selectTail(
            current,
            valid.handoff,
            "commit",
            valid.sessionId,
            valid.runId
          )
          if (current.some((message) => message.message_id === valid.handoff.messageId)) {
            return yield* error("commit", "invalid", "Session handoff id is already active", valid)
          }
          const existing = yield* sql<{ readonly present: number }>`
        SELECT 1 AS present FROM session_messages
        WHERE session_id = ${valid.sessionId} AND message_id = ${valid.handoff.messageId}
        LIMIT 1
      `.pipe(Effect.mapError(mapStorage("commit", "Could not inspect Session handoff id", valid)))
          if (existing.length > 0) {
            return yield* error("commit", "conflict", "Session handoff id already exists", valid)
          }

          const handoffTurnId =
            loaded.run?.turn_id ??
            (yield* currentSessionTurnId(sql, valid.sessionId).pipe(
              Effect.mapError(mapStorage("commit", "Could not resolve the handoff turn", valid))
            ))
          if (handoffTurnId === null || handoffTurnId.length === 0) {
            return yield* error("commit", "corrupt", "Compaction has no durable turn owner", valid)
          }
          const handoffEnvelope = { ...valid.handoff.envelope, turn_id: handoffTurnId }
          const messageJson = yield* encodeJson(StoredMessageEnvelopeSchema, handoffEnvelope).pipe(
            Effect.mapError((cause) =>
              error("commit", "invalid", "Session handoff cannot be encoded", {
                sessionId: valid.sessionId,
                ...(valid.runId === undefined ? {} : { runId: valid.runId }),
                cause
              })
            )
          )

          const sequences = yield* sql<{ readonly value: number }>`
        SELECT COALESCE(MAX(seq) + 1, 0) AS value
        FROM session_messages
        WHERE session_id = ${valid.sessionId}
      `.pipe(
            Effect.mapError(
              mapStorage("commit", "Could not allocate Session handoff sequence", valid)
            )
          )
          const sequence = sequences[0]?.value ?? 0
          if (!Number.isSafeInteger(sequence) || sequence < 0) {
            return yield* error(
              "commit",
              "corrupt",
              "Session transcript sequence is invalid",
              valid
            )
          }

          yield* sql`
        INSERT INTO session_messages (
          session_id, message_id, seq, role, message_json, client_id, created_at, search_text
        ) VALUES (
          ${valid.sessionId}, ${valid.handoff.messageId}, ${sequence}, ${valid.handoff.role},
          ${messageJson}, ${valid.handoff.clientId}, ${valid.handoff.envelope.created_at},
          ${valid.handoff.searchText}
        )
      `.pipe(Effect.mapError(mapStorage("commit", "Could not append Session handoff", valid)))
          yield* sql`
        INSERT INTO chat_compactions (
          compaction_id, session_id, boundary_seq, messages_before, messages_after,
          rehydration_state, created_at
        ) VALUES (
          ${receipt.compactionId}, ${valid.sessionId}, ${sequence}, ${receipt.messagesBefore},
          ${receipt.messagesAfter}, ${rehydrationJson}, ${valid.handoff.envelope.created_at}
        )
      `.pipe(Effect.mapError(mapStorage("commit", "Could not persist compaction receipt", valid)))

          const messages = [valid.handoff.envelope, ...tail]
          yield* replaceActiveContext(sql, valid.sessionId, messages).pipe(
            Effect.mapError(mapStorage("commit", "Could not move the active context", valid))
          )
          const nextMetadata = { ...loaded.metadata }
          delete nextMetadata.last_input_tokens
          const metadataJson = yield* encodeJson(JsonObjectSchema, nextMetadata).pipe(
            Effect.mapError((cause) =>
              error("commit", "invalid", "Compacted metadata cannot be encoded", {
                sessionId: valid.sessionId,
                ...(valid.runId === undefined ? {} : { runId: valid.runId }),
                cause
              })
            )
          )
          const timestamp = DateTime.formatIso(yield* DateTime.now)
          const updated = yield* sql<{ readonly context_generation: number }>`
        UPDATE sessions
        SET metadata = ${metadataJson},
            context_generation = context_generation + 1,
            last_activity = CASE WHEN ${valid.purpose === "idle" ? 1 : 0} = 1
              THEN last_activity ELSE ${timestamp} END
        WHERE session_id = ${valid.sessionId}
          AND archived_at IS NULL
          AND context_generation = ${valid.expectedContextGeneration}
        RETURNING context_generation
      `.pipe(Effect.mapError(mapStorage("commit", "Could not replace compacted projection", valid)))
          const nextGeneration = updated[0]?.context_generation
          if (updated.length !== 1 || nextGeneration === undefined) {
            return yield* error(
              "commit",
              "conflict",
              "Session context changed while compaction committed",
              valid
            )
          }
          yield* moveMemoryCaptureContextInTransaction(sql, {
            sessionId: valid.sessionId,
            from: valid.expectedContextGeneration,
            to: nextGeneration
          }).pipe(
            Effect.mapError(
              mapStorage(
                "commit",
                "Could not preserve Memory capture progress across compaction",
                valid
              )
            )
          )
          yield* appendSessionTurn(sql, {
            sessionId: valid.sessionId,
            turnId: handoffTurnId,
            firstSequence: sequence,
            messages: [handoffEnvelope]
          }).pipe(Effect.mapError(mapStorage("commit", "Could not extend the Session turn", valid)))
          if (valid.purpose === "idle") {
            yield* sessionEvents
              .appendInTransaction("session_activity", valid.sessionId)
              .pipe(
                Effect.mapError(mapStorage("commit", "Could not announce idle compaction", valid))
              )
            yield* chatEvents
              .appendInTransaction({
                sessionId: valid.sessionId,
                events: [{ event: { type: "transcript_changed" } }]
              })
              .pipe(
                Effect.mapError(mapStorage("commit", "Could not refresh the compacted chat", valid))
              )
          }
          return {
            sessionId: valid.sessionId,
            contextGeneration: nextGeneration,
            messagesBefore: receipt.messagesBefore,
            messagesAfter: receipt.messagesAfter,
            messages
          }
        })
      )
      .pipe(Effect.mapError(mapStorage("commit", "Could not commit Session compaction", valid)))
  })

  return ContextCompactionStore.of({ measure, snapshot, commit })
}
