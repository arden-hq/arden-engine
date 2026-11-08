import { QuestionAnswerSchema } from "@arden-hq/protocol/effect/chat"
import type { ChatProjectionEvent } from "@arden-hq/protocol"
import { Effect, Option, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { ChatWriteError } from "../chat/store.js"
import { StoredMessageEnvelopeSchema, type StoredMessageEnvelope } from "../transcript/model.js"
import { decodeJson } from "./json.js"
import { appendQuestionChanges } from "./question-events.js"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import type { RunRow } from "./chat-run.js"
import { writeError, type ChatWriteOperation } from "./chat-write-errors.js"

interface PendingMessageRow {
  readonly client_id: string
  readonly message_id: string | null
  readonly message_json: string | null
  readonly created_at: string
}

interface PendingIngestion {
  readonly messages: ReadonlyArray<StoredMessageEnvelope>
  readonly events: ReadonlyArray<{
    readonly event: ChatProjectionEvent
    readonly runId: string
  }>
}

export const loadPendingInTransaction = Effect.fn("SqliteChatWriteStore.loadPending")(function* (
  sql: SqlClient.SqlClient,
  run: RunRow,
  operation: ChatWriteOperation
): Effect.fn.Return<PendingIngestion, ChatWriteError> {
  const rows = yield* sql<PendingMessageRow>`
    SELECT receipts.client_id, receipts.message_id,
           receipts.message_json, receipts.created_at
    FROM chat_idempotency_keys AS receipts
    WHERE receipts.session_id = ${run.session_id}
      AND receipts.run_id = ${run.run_id}
      AND receipts.status = 'queued'
    ORDER BY receipts.created_at, receipts.client_id
  `.pipe(
    Effect.mapError((cause) =>
      writeError(operation, "storage", "Could not load pending chat messages", {
        sessionId: run.session_id,
        runId: run.run_id,
        cause
      })
    )
  )

  const messages = yield* Effect.forEach(
    rows,
    Effect.fn("SqliteChatWriteStore.messages.row")(function* (row) {
      if (row.message_id === null || row.message_json === null) {
        return yield* writeError(operation, "corrupt", "Pending chat message is missing", {
          sessionId: run.session_id,
          runId: run.run_id
        })
      }
      const message = yield* decodeJson(StoredMessageEnvelopeSchema, row.message_json).pipe(
        Effect.mapError((cause) =>
          writeError(operation, "corrupt", "Pending chat message is corrupt", {
            sessionId: run.session_id,
            runId: run.run_id,
            cause
          })
        )
      )
      if (
        message.role !== "user" ||
        message.message_id !== row.message_id ||
        message.client_id !== row.client_id
      ) {
        return yield* writeError(operation, "corrupt", "Pending chat message identity is invalid", {
          sessionId: run.session_id,
          runId: run.run_id
        })
      }
      return message
    })
  )

  return {
    messages,
    events: rows.map((row) => ({
      event: {
        type: "message_ingested",
        client_id: row.client_id,
        run_id: run.run_id
      } satisfies ChatProjectionEvent,
      runId: run.run_id
    }))
  }
})

export const markPendingIngested = Effect.fn("SqliteChatWriteStore.markPendingIngested")(function* (
  sql: SqlClient.SqlClient,
  run: RunRow,
  timestamp: string,
  operation: ChatWriteOperation
): Effect.fn.Return<void, ChatWriteError> {
  yield* sql`
    UPDATE chat_idempotency_keys
    SET status = 'ingested', updated_at = ${timestamp}
    WHERE session_id = ${run.session_id}
      AND run_id = ${run.run_id}
      AND status = 'queued'
  `.pipe(
    Effect.mapError((cause) =>
      writeError(operation, "storage", "Could not settle pending chat messages", {
        sessionId: run.session_id,
        runId: run.run_id,
        cause
      })
    )
  )
})

const answeredQuestionIds = (messages: ReadonlyArray<StoredMessageEnvelope>): Array<string> =>
  messages.flatMap((message) => {
    const marker = Schema.decodeUnknownOption(QuestionAnswerSchema)(message.question_answer)
    return Option.isSome(marker) ? [marker.value.question_id] : []
  })

export const announceAnswers = (options: {
  readonly sql: SqlClient.SqlClient
  readonly sessionEvents: SessionLifecycleEvents["Service"]
  readonly messages: ReadonlyArray<StoredMessageEnvelope>
}) =>
  appendQuestionChanges({
    sql: options.sql,
    sessionEvents: options.sessionEvents,
    questionIds: answeredQuestionIds(options.messages)
  })
