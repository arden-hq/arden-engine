import { journalRunIdSql } from "./journal-run-boundary.js"
import { randomUUID } from "node:crypto"
import type { RunEnding } from "./tool-receipts.js"
import type { ChatProjectionEvent } from "@arden-hq/protocol"
import type { ChatRunErrorCode } from "@arden-hq/protocol/chat"
import { journalRecordsSql } from "@arden-hq/journal/effect"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { ChatEventStore } from "../events/store.js"
import type { EventDraft } from "../events/model.js"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import {
  StoredMessageEnvelopeSchema,
  type StoredMessageEnvelope,
  visibleMessageCount
} from "../transcript/model.js"
import { transcriptSearchText } from "../transcript/search-text.js"
import { announceAnswers } from "./chat-pending.js"
import { hasResumableTail } from "./chat-transcript.js"
import { decodeJson, encodeJson } from "./json.js"
import { requireActiveContextWindow } from "./active-context.js"
import { activeRunStatusList } from "./status-sets.js"
import { appendSessionTurn } from "./turns.js"
import type { RunTerminal } from "./run-ending.js"

interface LatestMessageRow {
  readonly message_json: string
}

export interface ActiveChatRunRow {
  readonly run_id: string
  readonly session_id: string
  readonly turn_id: string
  readonly assistant_message_id: string
  readonly cancellation_requested: number
}

export interface RecoveryCause {
  readonly stopReason: string
  readonly interruption: string
  readonly errorCode: ChatRunErrorCode
  readonly approvalDetail: string
  readonly ending: RunEnding
}

type RecoveredSettlement =
  | { readonly _tag: "finish"; readonly reply: StoredMessageEnvelope }
  | { readonly _tag: "fail" }
  | { readonly _tag: "cancel" }

export interface QueuedMessage {
  readonly clientId: string
  readonly message: StoredMessageEnvelope
}

export const settledToolStatus = {
  finish: "completed",
  fail: "failed",
  cancel: "cancelled"
} as const

const replyText = (reply: StoredMessageEnvelope): string =>
  typeof reply.content === "string" ? reply.content : ""

export const terminalEvent = (
  outcome: RecoveredSettlement,
  run: ActiveChatRunRow,
  messageCount: number,
  cause: RecoveryCause
): ChatProjectionEvent => {
  switch (outcome._tag) {
    case "finish":
      return {
        type: "RUN_FINISHED",
        run_id: run.run_id,
        session_id: run.session_id,
        turn_id: run.turn_id,
        message_count: messageCount
      }
    case "cancel":
      return {
        type: "run_cancelled",
        run_id: run.run_id,
        session_id: run.session_id,
        turn_id: run.turn_id
      }
    case "fail":
      return {
        type: "RUN_ERROR",
        run_id: run.run_id,
        session_id: run.session_id,
        turn_id: run.turn_id,
        code: cause.errorCode,
        message: cause.interruption
      }
  }
}

export const runTerminal = (outcome: RecoveredSettlement, cause: RecoveryCause): RunTerminal => {
  switch (outcome._tag) {
    case "finish":
      return { status: "completed", result: replyText(outcome.reply) }
    case "cancel":
      return { status: "cancelled" }
    case "fail":
      return { status: "failed", error: cause.interruption }
  }
}

interface StreamedMessageRow {
  readonly event_type: string
  readonly message_id: unknown
}

interface RunStreamedMessages {
  readonly started: ReadonlyArray<string>
  readonly openText: ReadonlyArray<string>
}

export const loadRunStreamedMessages = Effect.fn("SqlitePersistence.loadRunStreamedMessages")(
  function* (sql: SqlClient.SqlClient, sessionId: string, runId: string) {
    const rows = yield* sql<StreamedMessageRow>`
      SELECT
        record.event_type AS event_type,
        COALESCE(retracted.value, json_extract(record.data_json, '$.message_id')) AS message_id
      FROM ${journalRecordsSql(sql)} AS record
      LEFT JOIN json_each(record.data_json, '$.message_ids') AS retracted
      WHERE record.stream_id = ${sessionId}
        AND ${journalRunIdSql(sql)} = ${runId}
        AND record.event_type IN (
          'TEXT_MESSAGE_START',
          'TEXT_MESSAGE_END',
          'REASONING_MESSAGE_START',
          'model_response_reset'
        )
      ORDER BY record.sequence, retracted.key
    `
    const started = new Set<string>()
    const openText = new Set<string>()
    for (const row of rows) {
      if (typeof row.message_id !== "string") continue
      if (row.event_type === "model_response_reset") {
        started.delete(row.message_id)
        openText.delete(row.message_id)
        continue
      }
      if (row.event_type === "TEXT_MESSAGE_END") {
        openText.delete(row.message_id)
        continue
      }
      started.add(row.message_id)
      if (row.event_type === "TEXT_MESSAGE_START") openText.add(row.message_id)
    }
    return { started: [...started], openText: [...openText] } satisfies RunStreamedMessages
  }
)

export const appendRecoveredMessagesInTransaction = Effect.fn(
  "SqlitePersistence.appendRecoveredMessages"
)(function* (
  sql: SqlClient.SqlClient,
  run: ActiveChatRunRow,
  messages: ReadonlyArray<StoredMessageEnvelope>,
  timestamp: string
) {
  if (messages.length === 0) return []
  yield* requireActiveContextWindow(sql, run.session_id)
  const sequenceRows = yield* sql<{ readonly value: number }>`
    SELECT COALESCE(MAX(seq) + 1, 0) AS value
    FROM session_messages
    WHERE session_id = ${run.session_id}
  `
  const firstSequence = sequenceRows[0]?.value ?? 0
  let sequence = firstSequence
  const stamped = messages.map((message) => ({ ...message, turn_id: run.turn_id }))
  for (const message of stamped) {
    const encoded = yield* encodeJson(StoredMessageEnvelopeSchema, message)
    yield* sql`
      INSERT INTO session_messages (
        session_id, message_id, seq, role, message_json, client_id,
        created_at, search_text
      ) VALUES (
        ${run.session_id}, ${message.message_id}, ${sequence}, ${message.role},
        ${encoded}, ${message.client_id ?? null}, ${message.created_at},
        ${transcriptSearchText(message)}
      )
    `
    sequence += 1
  }
  yield* sql`
    UPDATE sessions
    SET active_message_count = active_message_count + ${stamped.length},
        visible_message_count = visible_message_count + ${visibleMessageCount(stamped)},
        last_activity = ${timestamp}
    WHERE session_id = ${run.session_id}
  `
  yield* appendSessionTurn(sql, {
    sessionId: run.session_id,
    turnId: run.turn_id,
    firstSequence,
    messages
  })
  return stamped
})

export const continueFinishedRunInTransaction = Effect.fn("SqlitePersistence.continueFinishedRun")(
  function* (
    sql: SqlClient.SqlClient,
    chatEvents: ChatEventStore["Service"],
    sessionEvents: SessionLifecycleEvents["Service"],
    input: {
      readonly run: ActiveChatRunRow
      readonly queued: ReadonlyArray<QueuedMessage>
      readonly timestamp: string
      readonly cause: RecoveryCause
    }
  ) {
    const { run, queued, timestamp, cause } = input
    const messages = queued.map((item) => item.message)
    yield* appendRecoveredMessagesInTransaction(sql, run, messages, timestamp)
    yield* sql`
      UPDATE chat_idempotency_keys
      SET status = 'ingested', updated_at = ${timestamp}
      WHERE run_id = ${run.run_id} AND status = 'queued'
    `
    yield* announceAnswers({ sql, sessionEvents, messages })
    const { openText } = yield* loadRunStreamedMessages(sql, run.session_id, run.run_id)
    const nextAssistantMessageId = randomUUID()
    const events: Array<EventDraft> = [
      ...queued.map((item): EventDraft => ({
        event: { type: "message_ingested", client_id: item.clientId, run_id: run.run_id },
        runId: run.run_id
      })),
      { event: { type: "transcript_changed" }, runId: run.run_id }
    ]
    for (const messageId of openText) {
      events.push({
        event: { type: "TEXT_MESSAGE_END", message_id: messageId, session_id: run.session_id },
        runId: run.run_id
      })
    }
    events.push({
      event: { type: "TEXT_MESSAGE_START", message_id: nextAssistantMessageId, role: "assistant" },
      runId: run.run_id
    })
    const committed = yield* chatEvents.appendInTransaction({
      sessionId: run.session_id,
      events
    })
    yield* sql`
      UPDATE chat_runs
      SET status = 'pending', assistant_message_id = ${nextAssistantMessageId},
          updated_at = ${timestamp}, last_seq = ${committed.headSequence},
          metadata_json = json_set(
            metadata_json, '$.resumed',
            json_insert(
              COALESCE(json_extract(metadata_json, '$.resumed'), '[]'),
              '$[#]', json_object('at', ${timestamp}, 'cause', ${cause.stopReason})
            )
          )
      WHERE run_id = ${run.run_id}
        AND status IN ${activeRunStatusList}
    `
    yield* chatEvents.setCheckpointInTransaction(run.session_id, committed.headSequence)
    yield* sessionEvents.appendInTransaction("session_activity", run.session_id)
    return { settled: false }
  }
)

export const settlementOf = (
  cancelled: boolean,
  finalReply: StoredMessageEnvelope | undefined
): RecoveredSettlement => {
  if (cancelled) return { _tag: "cancel" }
  if (finalReply === undefined) return { _tag: "fail" }
  return { _tag: "finish", reply: finalReply }
}

export const durableFinalReply = (
  sql: SqlClient.SqlClient,
  runId: string
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const rows = yield* sql<LatestMessageRow>`
      SELECT message.message_json
      FROM chat_runs AS run
      JOIN session_messages AS message
        ON message.session_id = run.session_id
        AND message.message_id = run.completion_message_id
      WHERE run.run_id = ${runId}
    `
    if (rows[0] === undefined) return undefined
    const latest = yield* decodeJson(StoredMessageEnvelopeSchema, rows[0].message_json)
    if (hasResumableTail([latest])) return undefined
    const text = replyText(latest).trim()
    return text.length === 0 ? undefined : text
  }).pipe(Effect.orElseSucceed(() => undefined))
