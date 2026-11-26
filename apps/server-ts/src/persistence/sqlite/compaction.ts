import { ROLE } from "@arden-hq/std/message-vocabulary"
import { DateTime, Effect, Schema } from "effect"
import {
  CONTEXT_COMPACTION_PURPOSE,
  ContextCompactionStore,
  ContextCompactionStoreError,
  type ContextCompactionCommitInput,
  type ContextCompactionCommitResult,
  type ContextCompactionMeasure,
  type ContextCompactionOperation,
  type ContextCompactionSnapshot,
  type ContextCompactionSnapshotInput
} from "../compaction/store.js"
import { JsonObjectSchema } from "../json.js"
import {
  messageAuthor,
  StoredMessageEnvelopeSchema,
  TranscriptMessageDraftSchema
} from "../transcript/model.js"
import { decodeWith, encodeJson } from "./json.js"
import { appendSessionTurn, currentSessionTurnId } from "./turns.js"
import { replaceActiveContext } from "./active-context.js"
import { makeOwnerWordsIn } from "./transcript-owner-messages.js"
import type { PersistenceDeps } from "./deps.js"
import {
  contextVersion,
  error,
  invalidInput,
  load,
  loadMessages,
  mapStorage,
  selectTail
} from "./compaction-context.js"

const snapshotInputSchema = Schema.Struct({
  purpose: Schema.optionalKey(Schema.Literal(CONTEXT_COMPACTION_PURPOSE.idle)),
  sessionId: Schema.NonEmptyString,
  runId: Schema.optionalKey(Schema.NonEmptyString)
})

const commitInputSchema = Schema.Struct({
  purpose: Schema.optionalKey(Schema.Literal(CONTEXT_COMPACTION_PURPOSE.idle)),
  sessionId: Schema.NonEmptyString,
  runId: Schema.optionalKey(Schema.NonEmptyString),
  expectedContextGeneration: Schema.Natural,
  expectedContextVersion: Schema.NonEmptyString,
  handoff: TranscriptMessageDraftSchema
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
        const messages = yield* loadMessages(reader, valid, "snapshot")
        const ownerWords = yield* makeOwnerWordsIn(reader)(
          valid.sessionId,
          messages.flatMap((message) => (message.role === ROLE.user ? [message.message_id] : []))
        ).pipe(
          Effect.mapError((cause) =>
            error("snapshot", "storage", "Could not read the owner's words", { ...valid, cause })
          )
        )
        return {
          sessionId: loaded.row.session_id,
          sessionRef: loaded.row.public_ref,
          sourceSessionRef: loaded.row.source_ref ?? undefined,
          runId: run?.run_id ?? null,
          modelId: run?.model_id ?? loaded.row.chat_model,
          reasoningEffort: run?.reasoning_effort ?? null,
          messages,
          ownerWords,
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
          session_id, message_id, seq, role, message_json, client_id, created_at, search_text,
          author
        ) VALUES (
          ${valid.sessionId}, ${valid.handoff.messageId}, ${sequence}, ${valid.handoff.role},
          ${messageJson}, ${valid.handoff.clientId}, ${valid.handoff.envelope.created_at},
          ${valid.handoff.searchText}, ${messageAuthor(valid.handoff.envelope)}
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
            last_activity = CASE WHEN ${valid.purpose === CONTEXT_COMPACTION_PURPOSE.idle ? 1 : 0} = 1
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
          yield* appendSessionTurn(sql, {
            sessionId: valid.sessionId,
            turnId: handoffTurnId,
            firstSequence: sequence,
            messages: [handoffEnvelope]
          }).pipe(Effect.mapError(mapStorage("commit", "Could not extend the Session turn", valid)))
          if (valid.purpose === CONTEXT_COMPACTION_PURPOSE.idle) {
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
