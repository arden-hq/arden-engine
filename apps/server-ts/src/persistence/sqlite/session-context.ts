import { DateTime, Effect, Schema } from "effect"
import {
  SessionStoreError,
  type RevertedTurns,
  type RevertOptions,
  type SessionStore
} from "../sessions/store.js"
import { StoredMessageEnvelopeSchema, type StoredMessageEnvelope } from "../transcript/model.js"
import { JsonObjectSchema } from "../json.js"
import { decodeJson, encodeJson } from "./json.js"
import { rebuildSessionTurns } from "./turns.js"
import { deleteGoneTurnRecordsInTransaction, turnIdsOf } from "./turn-records.js"
import {
  activeSessionExternalWorkPredicate,
  activeSessionRunPredicate
} from "./session-blocking-work.js"
import { nextId } from "./deps.js"
import type { PersistenceDeps } from "./deps.js"
import { OptionalInputTokens, storeError, sessionIdSchema } from "./session-rows.js"
import { ActiveContextError, loadActiveContext, replaceActiveContext } from "./active-context.js"

interface MutableSessionRow {
  readonly session_id: string
  readonly context_generation: number
  readonly metadata: string | null
  readonly has_active_run: number
  readonly has_active_external_work: number
  readonly has_pending_approval: number
  readonly has_compaction: number
}

const RevertOptionsSchema = Schema.Struct({
  sessionId: Schema.optionalKey(Schema.UndefinedOr(Schema.NonEmptyString)),
  turns: Schema.optionalKey(Schema.UndefinedOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))),
  messageId: Schema.optionalKey(Schema.UndefinedOr(Schema.NonEmptyString))
})

export const makeSessionContext = ({
  writer,
  sessionEvents
}: Pick<PersistenceDeps, "writer"> & {
  readonly sessionEvents: Pick<PersistenceDeps["sessionEvents"], "appendEventInTransaction">
}): Pick<SessionStore["Service"], "clear" | "revert"> => {
  const sql = writer.sql
  type ContextMutation = "clear" | "revert"

  const loadMutableSession = Effect.fn("SqliteSessionStore.loadMutableSession")(function* (
    sessionId: string | null,
    operation: ContextMutation
  ): Effect.fn.Return<MutableSessionRow | null, SessionStoreError> {
    const target =
      sessionId === null
        ? sql`WHERE s.archived_at IS NULL ORDER BY s.last_activity DESC, s.session_id DESC`
        : sql`WHERE s.session_id = ${sessionId}`
    const rows = yield* sql<MutableSessionRow>`
      SELECT s.session_id, s.context_generation,
             s.metadata,
             ${activeSessionRunPredicate(sql)} AS has_active_run,
             ${activeSessionExternalWorkPredicate(sql)} AS has_active_external_work,
             EXISTS (
               SELECT 1 FROM tool_approvals AS approval
               WHERE approval.session_id = s.session_id AND approval.status = 'pending'
             ) AS has_pending_approval,
             EXISTS(SELECT 1 FROM chat_compactions WHERE session_id = s.session_id) AS has_compaction
      FROM sessions AS s
      ${target}
      LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        storeError(
          operation,
          "storage",
          "Could not load the session",
          sessionId ?? undefined,
          cause
        )
      )
    )
    const row = rows[0]
    if (row === undefined) return null
    if (
      ![
        row.has_active_run,
        row.has_active_external_work,
        row.has_pending_approval,
        row.has_compaction
      ].every((value) => value === 0 || value === 1)
    ) {
      return yield* storeError(
        operation,
        "storage",
        "Session context flags are corrupt",
        row.session_id
      )
    }
    if (row.has_active_run === 1 || row.has_active_external_work === 1) {
      return yield* storeError(
        operation,
        "conflict",
        row.has_pending_approval === 1
          ? "Arden is waiting on an approval in this chat. Answer it first."
          : "Arden is still finishing work in this chat. Try again when it stops.",
        row.session_id
      )
    }
    return row
  })

  const loadProjection = (row: MutableSessionRow, operation: ContextMutation) =>
    loadActiveContext(sql, row.session_id).pipe(
      Effect.mapError((cause) =>
        storeError(
          operation,
          "storage",
          cause instanceof ActiveContextError ? cause.message : "Could not load the active context",
          row.session_id,
          cause
        )
      )
    )

  const moveWindow = (
    row: MutableSessionRow,
    operation: ContextMutation,
    messages: ReadonlyArray<StoredMessageEnvelope>
  ) =>
    replaceActiveContext(sql, row.session_id, messages).pipe(
      Effect.mapError((cause) =>
        storeError(operation, "storage", "Could not move the active context", row.session_id, cause)
      )
    )

  const clear = Effect.fn("SqliteSessionStore.clear")(function* (
    sessionIdInput?: string
  ): Effect.fn.Return<string | undefined, SessionStoreError> {
    const sessionId =
      sessionIdInput === undefined
        ? null
        : yield* Schema.decodeUnknownEffect(sessionIdSchema)(sessionIdInput).pipe(
            Effect.mapError((cause) =>
              storeError("clear", "invalid", "Session id must not be empty", sessionIdInput, cause)
            )
          )

    return yield* writer
      .transact(
        Effect.gen(function* () {
          const row = yield* loadMutableSession(sessionId, "clear")
          if (row === null) return undefined
          const timestamp = DateTime.formatIso(yield* DateTime.now)
          const updated = yield* sql<{ readonly session_id: string }>`
        UPDATE sessions
        SET metadata = json_remove(COALESCE(metadata, '{}'), '$.last_input_tokens'),
            context_generation = context_generation + 1,
            last_activity = ${timestamp}, has_unread = 0
        WHERE session_id = ${row.session_id}
          AND context_generation = ${row.context_generation}
        RETURNING session_id
      `.pipe(
            Effect.mapError((cause) =>
              storeError(
                "clear",
                "storage",
                "Could not clear the session projection",
                row.session_id,
                cause
              )
            )
          )
          if (updated.length !== 1) {
            return yield* storeError(
              "clear",
              "conflict",
              "This chat changed while it was being cleared. Try again.",
              row.session_id
            )
          }
          const clearedTurns = yield* sql<{ readonly turn_id: string }>`
            SELECT turn_id FROM session_turns WHERE session_id = ${row.session_id}`
          yield* sql`DELETE FROM session_messages WHERE session_id = ${row.session_id}`
          yield* sql`DELETE FROM session_turns WHERE session_id = ${row.session_id}`
          yield* sql`DELETE FROM chat_compactions WHERE session_id = ${row.session_id}`
          yield* deleteGoneTurnRecordsInTransaction({
            sql,
            sessionEvents,
            sessionId: row.session_id,
            turnIds: clearedTurns.map((turn) => turn.turn_id)
          })
          yield* moveWindow(row, "clear", [])
          return row.session_id
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof SessionStoreError
            ? cause
            : storeError(
                "clear",
                "storage",
                "Could not clear the session",
                sessionId ?? undefined,
                cause
              )
        )
      )
  })

  const revert = Effect.fn("SqliteSessionStore.revert")(function* (
    options: RevertOptions
  ): Effect.fn.Return<RevertedTurns | undefined, SessionStoreError> {
    const valid = yield* Schema.decodeUnknownEffect(RevertOptionsSchema)(options, {
      onExcessProperty: "error"
    }).pipe(
      Effect.mapError((cause) =>
        storeError("revert", "invalid", "Invalid revert-session request", options.sessionId, cause)
      )
    )
    const sessionId = valid.sessionId ?? null

    return yield* writer
      .transact(
        Effect.gen(function* () {
          const row = yield* loadMutableSession(sessionId, "revert")
          if (row === null) return undefined
          const projection = yield* loadProjection(row, "revert")
          if (projection.length === 0) return undefined
          let target = -1
          if (valid.messageId !== undefined) {
            target = projection.findIndex(
              (message) =>
                message.message_id === valid.messageId || message.client_id === valid.messageId
            )
          } else {
            let remaining = valid.turns ?? 1
            for (let index = projection.length - 1; index >= 0; index -= 1) {
              if (projection[index]?.role !== "user") continue
              remaining -= 1
              if (remaining === 0) {
                target = index
                break
              }
            }
          }
          if (target < 0) return undefined

          const targetMessage = projection[target]
          if (targetMessage === undefined) {
            return yield* storeError(
              "revert",
              "storage",
              "Revert target is corrupt",
              row.session_id
            )
          }
          const rawContent = targetMessage.content
          let userMessage = ""
          if (typeof rawContent === "string") {
            userMessage = rawContent
          } else if (Array.isArray(rawContent)) {
            userMessage = rawContent
              .flatMap((block) => {
                if (typeof block !== "object" || block === null || Array.isArray(block)) return []
                return block.type === "text" &&
                  typeof block.text === "string" &&
                  block.text.length > 0
                  ? [block.text]
                  : []
              })
              .join("\n\n")
          }
          const discardedMessageIds = [
            ...new Set(projection.slice(target).map((message) => message.message_id))
          ]
          let replacement = projection.slice(0, target)
          let handoffIndex = -1
          for (let index = replacement.length - 1; index >= 0; index -= 1) {
            const receipt = replacement[index]?.compaction
            const receiptRecord =
              typeof receipt === "object" && receipt !== null && !Array.isArray(receipt)
                ? (receipt as Readonly<Record<string, unknown>>)
                : null
            if (receiptRecord?.kind === "session_handoff") {
              handoffIndex = index
              break
            }
          }
          let renewedHandoff: {
            readonly message: StoredMessageEnvelope
            readonly messageJson: string
            readonly rehydrationJson: string | null
          } | null = null
          const previous = handoffIndex >= 0 ? replacement[handoffIndex] : undefined
          if (previous !== undefined) {
            const previousReceipt = previous.compaction as Readonly<Record<string, unknown>>
            const preservedTailIds = replacement
              .slice(handoffIndex + 1)
              .map((message) => message.message_id)
            const compactionId = yield* nextId
            const rehydration = previousReceipt.rehydration
            const rehydrationState =
              typeof rehydration === "object" && rehydration !== null && !Array.isArray(rehydration)
                ? (rehydration as Readonly<Record<string, Schema.Json>>)
                : null
            const rehydrationJson =
              rehydrationState === null
                ? null
                : yield* encodeJson(JsonObjectSchema, rehydrationState).pipe(
                    Effect.mapError((cause) =>
                      storeError(
                        "revert",
                        "storage",
                        "Could not encode the renewed handoff",
                        row.session_id,
                        cause
                      )
                    )
                  )
            const copyStrings = (value: unknown): ReadonlyArray<string> | undefined =>
              Array.isArray(value) && value.every((item) => typeof item === "string")
                ? [...new Set(value)]
                : undefined
            const toolResultRefs = copyStrings(previousReceipt.tool_result_refs)
            const backgroundResultRefs = copyStrings(previousReceipt.background_result_refs)
            const compaction = {
              compaction_id: compactionId,
              kind: "session_handoff",
              ...(typeof previousReceipt.message_start_id === "string"
                ? { message_start_id: previousReceipt.message_start_id }
                : {}),
              ...(typeof previousReceipt.message_end_id === "string"
                ? { message_end_id: previousReceipt.message_end_id }
                : {}),
              parent_compaction_id: previous.message_id,
              reason: "user_rewind",
              messages_before: projection.length,
              messages_after: replacement.length,
              preserved_tail_ids: preservedTailIds,
              ...(toolResultRefs === undefined ? {} : { tool_result_refs: toolResultRefs }),
              ...(backgroundResultRefs === undefined
                ? {}
                : { background_result_refs: backgroundResultRefs }),
              rehydration: rehydrationState
            }
            const message: StoredMessageEnvelope = {
              message_id: compactionId,
              role: "assistant",
              created_at: DateTime.formatIso(yield* DateTime.now),
              content: previous.content ?? "",
              compaction
            }
            const messageJson = yield* encodeJson(StoredMessageEnvelopeSchema, {
              ...message,
              turn_id: compactionId
            }).pipe(
              Effect.mapError((cause) =>
                storeError(
                  "revert",
                  "storage",
                  "Could not encode the renewed handoff",
                  row.session_id,
                  cause
                )
              )
            )
            replacement = [
              ...replacement.slice(0, handoffIndex),
              message,
              ...replacement.slice(handoffIndex + 1)
            ]
            renewedHandoff = { message, messageJson, rehydrationJson }
          }
          const metadata = yield* decodeJson(JsonObjectSchema, row.metadata ?? "{}").pipe(
            Effect.mapError((cause) =>
              storeError("revert", "storage", "Session metadata is corrupt", row.session_id, cause)
            )
          )
          const lastInputTokens = yield* Schema.decodeUnknownEffect(OptionalInputTokens)(
            metadata.last_input_tokens ?? null
          ).pipe(
            Effect.mapError((cause) =>
              storeError(
                "revert",
                "storage",
                "Session input-token metadata is corrupt",
                row.session_id,
                cause
              )
            )
          )
          const { last_input_tokens: _reading, ...settings } = metadata
          const metadataJson = yield* encodeJson(
            JsonObjectSchema,
            lastInputTokens === null || lastInputTokens === 0
              ? settings
              : { ...settings, last_input_tokens: lastInputTokens }
          ).pipe(
            Effect.mapError((cause) =>
              storeError(
                "revert",
                "storage",
                "Could not encode reverted session metadata",
                row.session_id,
                cause
              )
            )
          )
          const timestamp = DateTime.formatIso(yield* DateTime.now)
          if (renewedHandoff !== null) {
            const sequences = yield* sql<{ readonly value: number }>`
                SELECT COALESCE(MAX(seq) + 1, 0) AS value
                FROM session_messages
                WHERE session_id = ${row.session_id}
              `
            const sequence = sequences[0]?.value
            if (sequence === undefined || !Number.isSafeInteger(sequence) || sequence < 0) {
              return yield* storeError(
                "revert",
                "storage",
                "Could not allocate the renewed handoff sequence",
                row.session_id
              )
            }
            yield* sql`
                INSERT INTO session_messages (
                  session_id, message_id, seq, role, message_json,
                  client_id, created_at, search_text
                ) VALUES (
                  ${row.session_id}, ${renewedHandoff.message.message_id}, ${sequence},
                  'assistant', ${renewedHandoff.messageJson}, NULL,
                  ${renewedHandoff.message.created_at},
                  ${
                    typeof renewedHandoff.message.content === "string"
                      ? renewedHandoff.message.content
                      : null
                  }
                )
              `
            yield* sql`
                INSERT INTO chat_compactions (
                  compaction_id, session_id, boundary_seq, messages_before,
                  messages_after, rehydration_state, created_at
                ) VALUES (
                  ${renewedHandoff.message.message_id}, ${row.session_id}, ${sequence},
                  ${projection.length}, ${replacement.length},
                  ${renewedHandoff.rehydrationJson}, ${renewedHandoff.message.created_at}
                )
              `
          }
          const updated = yield* sql<{ readonly session_id: string }>`
        UPDATE sessions
        SET metadata = ${metadataJson},
            context_generation = context_generation + 1, last_activity = ${timestamp},
            has_unread = 0
        WHERE session_id = ${row.session_id}
          AND context_generation = ${row.context_generation}
        RETURNING session_id
      `.pipe(
            Effect.mapError((cause) =>
              storeError(
                "revert",
                "storage",
                "Could not replace the session projection",
                row.session_id,
                cause
              )
            )
          )
          if (updated.length !== 1) {
            return yield* storeError(
              "revert",
              "conflict",
              "This chat changed while it was being reverted. Try again.",
              row.session_id
            )
          }
          const firstDiscarded =
            discardedMessageIds.length === 0
              ? []
              : yield* sql<{ readonly seq: number | null }>`
                  SELECT MIN(seq) AS seq FROM session_messages
                  WHERE session_id = ${row.session_id}
                    AND message_id IN ${sql.in(discardedMessageIds)}
                `
          const discardedTurnIds = yield* turnIdsOf(sql, row.session_id, discardedMessageIds)
          yield* Effect.forEach(
            discardedMessageIds,
            (messageId) => sql`
              DELETE FROM session_messages
              WHERE session_id = ${row.session_id} AND message_id = ${messageId}
            `,
            { discard: true }
          )
          yield* moveWindow(row, "revert", replacement)
          yield* rebuildSessionTurns(sql, row.session_id, {
            fromSeq: firstDiscarded[0]?.seq ?? 0
          })
          yield* deleteGoneTurnRecordsInTransaction({
            sql,
            sessionEvents,
            sessionId: row.session_id,
            turnIds: discardedTurnIds
          })
          return {
            userMessage,
            revertedCount: projection.length - target
          }
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof SessionStoreError
            ? cause
            : storeError(
                "revert",
                "storage",
                "Could not revert the session",
                sessionId ?? undefined,
                cause
              )
        )
      )
  })

  return { clear, revert }
}
