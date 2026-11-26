import { ROLE } from "@arden-hq/std/message-vocabulary"
import { loadRun, requireReceiptForRun, setCheckpoint } from "./chat-run.js"
import { runTotals, textEnd } from "./recovery-finish.js"
import { readableConversationSql } from "./session-presentation.js"
import {
  MessageListSchema,
  appendMessagesInTransaction,
  historyTail,
  loadActiveMessages,
  loadTranscriptEnvelopesById
} from "./chat-transcript.js"
import { announceAnswers, loadPendingInTransaction, markPendingIngested } from "./chat-pending.js"
import { loadSession } from "./chat-session.js"
import { mapFailure, validateInput, writeError } from "./chat-write-errors.js"
import { takeChatEventsBeforeQueued } from "./chat-events.js"
import type { ChatProjectionEvent } from "@arden-hq/protocol"
import { settleRun } from "./run-settle.js"
import { recordFinalRunUsage } from "./run-usage.js"
import { StoredRunTerminalResultSchema as RunTerminalResultSchema } from "../runs/stored-result.js"
import { DateTime, Effect, Schema } from "effect"
import {
  type ChatWriteFinishResult,
  type ChatWriteFinishInput,
  type ChatWriteFailure,
  type ChatWriteStore
} from "../chat/store.js"
import { decodeJson, encodeJson } from "./json.js"
import { JsonObjectSchema } from "../json.js"
import { settleTerminalToolsInTransaction } from "./tool-terminal.js"
import { supersedeMessagesInTransaction } from "./superseded-messages.js"
import { nextId, type PersistenceDeps } from "./deps.js"
import { appendRunSettledInTransaction } from "./run-settled.js"
import { isTerminalRunStatus } from "@arden-hq/protocol/runs"
import { messageTurnIdSql } from "./message-turns.js"
import { turnTouchesRecencySql } from "./session-unread.js"
import { conversationMessagePredicate } from "./transcript-predicates.js"
import { assistantTextStart } from "./assistant-text-start.js"

const finishUsageSchema = Schema.Struct({
  prompt: Schema.Natural,
  completion: Schema.Natural,
  total: Schema.Natural,
  cache_read: Schema.Natural,
  cache_write: Schema.Natural,
  cost: Schema.optionalKey(Schema.Number)
})

const finishInputSchema = Schema.Struct({
  runId: Schema.NonEmptyString,
  messages: MessageListSchema,
  result: Schema.optionalKey(RunTerminalResultSchema),
  stopReason: Schema.optionalKey(Schema.NonEmptyString),
  usage: Schema.optionalKey(finishUsageSchema),
  lastInputTokens: Schema.optionalKey(Schema.NullOr(Schema.Natural)),
  terminalTextEnded: Schema.optionalKey(Schema.Boolean),
  supersededMessageIds: Schema.optionalKey(Schema.Array(Schema.NonEmptyString))
}).check(
  Schema.makeFilter((input) => {
    const issues: Array<Schema.FilterIssue> = []
    if (
      new Set(input.messages.map((message) => message.message_id)).size !== input.messages.length
    ) {
      issues.push({ path: ["messages"], issue: "message ids must be unique" })
    }
    return issues
  })
)

export const makeChatFinish = ({
  writer,
  chatEvents,
  sessionEvents
}: Pick<
  PersistenceDeps,
  "writer" | "chatEvents" | "sessionEvents"
>): ChatWriteStore["Service"]["finish"] => {
  const sql = writer.sql
  const finish = Effect.fn("SqliteChatWriteStore.finish")(function* (
    input: ChatWriteFinishInput
  ): Effect.fn.Return<ChatWriteFinishResult, ChatWriteFailure> {
    const valid = yield* validateInput(finishInputSchema, input, "finish")
    const now = yield* DateTime.now
    const timestamp = DateTime.formatIso(now)

    return yield* writer
      .transactInteractive(
        Effect.gen(function* () {
          const run = yield* loadRun(sql, valid.runId, "finish")
          if (isTerminalRunStatus(run.status)) {
            return yield* writeError("finish", "terminal", "Chat run is already terminal", {
              sessionId: run.session_id,
              runId: run.run_id
            })
          }
          const session = yield* loadSession(sql, run.session_id, "finish")
          const activeMessages = yield* loadActiveMessages(sql, run.session_id, "finish")
          const appended = yield* historyTail(
            sql,
            { sessionId: run.session_id, runId: run.run_id },
            valid.messages,
            "finish"
          )
          const projectedAssistantMessages = valid.messages.filter(
            (message) =>
              message.message_id === run.assistant_message_id && message.role === ROLE.assistant
          )
          const transcript = yield* loadTranscriptEnvelopesById(
            sql,
            run.session_id,
            [...appended.map((message) => message.message_id), run.assistant_message_id],
            "finish"
          )
          const transcriptAssistantMessages = transcript.filter(
            (message) =>
              message.message_id === run.assistant_message_id && message.role === ROLE.assistant
          )
          const runAssistantMessage =
            projectedAssistantMessages[0] ?? transcriptAssistantMessages[0]
          if (
            projectedAssistantMessages.length > 1 ||
            transcriptAssistantMessages.length > 1 ||
            runAssistantMessage === undefined
          ) {
            return yield* writeError(
              "finish",
              "invalid",
              "Chat history must contain the run assistant message",
              {
                sessionId: run.session_id,
                runId: run.run_id
              }
            )
          }
          const assistantMessage =
            [...valid.messages].reverse().find((message) => message.role === ROLE.assistant) ??
            runAssistantMessage
          yield* requireReceiptForRun(sql, run, "finish")
          const pending = yield* loadPendingInTransaction(sql, run, "finish")
          const transcriptIds = new Set(transcript.map((message) => message.message_id))
          if (appended.some((message) => transcriptIds.has(message.message_id))) {
            return yield* writeError(
              "finish",
              "invalid",
              "Chat history cannot reorder transcript messages",
              {
                sessionId: run.session_id,
                runId: run.run_id
              }
            )
          }
          for (const message of appended) {
            if (message.role === ROLE.system) {
              return yield* writeError(
                "finish",
                "invalid",
                "Chat history cannot append system messages",
                {
                  sessionId: run.session_id,
                  runId: run.run_id
                }
              )
            }
          }
          if (
            pending.messages.some((message) =>
              valid.messages.some((known) => known.message_id === message.message_id)
            )
          ) {
            return yield* writeError(
              "finish",
              "invalid",
              "Chat history already contains a queued message",
              {
                sessionId: run.session_id,
                runId: run.run_id
              }
            )
          }
          const recoveredTools = yield* settleTerminalToolsInTransaction(sql, {
            ending: "run_ended",
            operation: "finish",
            sessionId: run.session_id,
            runId: run.run_id,
            turnId: run.turn_id,
            terminalAt: timestamp,
            activeMessages,
            appendedMessages: appended,
            sessionEvents
          })
          const news = yield* takeChatEventsBeforeQueued(sql, {
            run,
            queued: pending.messages.length,
            now,
            operation: "finish"
          })
          const superseded = yield* supersedeMessagesInTransaction(sql, {
            sessionId: run.session_id,
            messageIds: valid.supersededMessageIds ?? [],
            active: [
              ...activeMessages,
              ...(yield* appendMessagesInTransaction(
                sql,
                run.session_id,
                [...appended, ...recoveredTools, ...news, ...pending.messages],
                timestamp,
                "finish",
                run.turn_id
              ))
            ]
          }).pipe(
            Effect.mapError((cause) =>
              writeError("finish", "storage", "Could not mark the replaced answer", {
                sessionId: run.session_id,
                runId: run.run_id,
                cause
              })
            )
          )
          const projection = superseded.active
          const replacedEvents =
            superseded.answerIds.length === 0
              ? []
              : [
                  {
                    event: {
                      type: "final_text_superseded",
                      run_id: run.run_id,
                      message_ids: [...superseded.answerIds],
                      state: "replaced"
                    } satisfies ChatProjectionEvent,
                    runId: run.run_id
                  }
                ]
          if (pending.messages.length > 0) {
            yield* markPendingIngested(sql, run, timestamp, "finish")
            yield* announceAnswers({ sql, sessionEvents, messages: pending.messages })
            const nextAssistantMessageId = yield* nextId
            const committed = yield* chatEvents
              .appendInTransaction({
                sessionId: run.session_id,
                events: [
                  ...pending.events,
                  {
                    event: { type: "transcript_changed" } satisfies ChatProjectionEvent,
                    runId: run.run_id
                  },
                  ...(valid.terminalTextEnded === true
                    ? []
                    : [
                        {
                          event: textEnd(
                            assistantMessage.message_id,
                            run.session_id,
                            assistantMessage.content
                          ),
                          runId: run.run_id
                        }
                      ]),
                  ...replacedEvents,
                  {
                    event: assistantTextStart(nextAssistantMessageId),
                    runId: run.run_id
                  }
                ]
              })
              .pipe(
                Effect.mapError((cause) =>
                  writeError("finish", "storage", "Could not continue the run after queued input", {
                    sessionId: run.session_id,
                    runId: run.run_id,
                    cause
                  })
                )
              )
            yield* sql`
            UPDATE chat_runs
            SET assistant_message_id = ${nextAssistantMessageId},
                updated_at = ${timestamp}
            WHERE run_id = ${run.run_id}
          `
            yield* setCheckpoint(
              sql,
              chatEvents,
              run.session_id,
              run.run_id,
              committed.headSequence,
              "finish"
            )
            yield* sessionEvents.appendInTransaction("session_activity", run.session_id)
            return {
              _tag: "Continued",
              activeMessages: projection,
              assistantMessageId: nextAssistantMessageId,
              eventSequence: committed.headSequence,
              committed
            } satisfies ChatWriteFinishResult
          }

          const metadata = yield* decodeJson(JsonObjectSchema, session.metadata ?? "{}").pipe(
            Effect.mapError((cause) =>
              writeError("finish", "corrupt", "Session metadata is corrupt", {
                sessionId: run.session_id,
                runId: run.run_id,
                cause
              })
            )
          )
          const nextMetadata = { ...metadata }
          if (valid.lastInputTokens !== undefined) {
            if (valid.lastInputTokens === null || valid.lastInputTokens === 0) {
              delete nextMetadata.last_input_tokens
            } else {
              nextMetadata.last_input_tokens = valid.lastInputTokens
            }
          }
          const metadataJson = yield* encodeJson(JsonObjectSchema, nextMetadata).pipe(
            Effect.mapError((cause) =>
              writeError("finish", "invalid", "Session metadata cannot be encoded", {
                sessionId: run.session_id,
                runId: run.run_id,
                cause
              })
            )
          )
          yield* sql`
          UPDATE sessions
          SET metadata = ${metadataJson},
              last_activity = CASE
              WHEN ${turnTouchesRecencySql(sql, { sessionId: run.session_id, turnId: run.turn_id })}
              THEN ${timestamp} ELSE last_activity END,
              has_unread = CASE WHEN ${readableConversationSql(sql)} AND EXISTS (
                SELECT 1
                FROM session_messages AS m
                WHERE m.session_id = ${run.session_id}
                  AND ${messageTurnIdSql(sql, "m")} = ${run.turn_id}
                  AND m.role = ${ROLE.assistant}
                  AND ${conversationMessagePredicate(sql)}
              ) THEN 1 ELSE has_unread END
          WHERE session_id = ${run.session_id}
        `

          const terminalResultJson = JSON.stringify(valid.result ?? null)

          const committed = yield* chatEvents
            .appendInTransaction({
              sessionId: run.session_id,
              events: [
                ...(recoveredTools.length === 0
                  ? []
                  : [
                      {
                        event: { type: "transcript_changed" } satisfies ChatProjectionEvent,
                        runId: run.run_id
                      }
                    ]),
                ...(valid.terminalTextEnded === true
                  ? []
                  : [
                      {
                        event: textEnd(
                          assistantMessage.message_id,
                          run.session_id,
                          assistantMessage.content
                        ),
                        runId: run.run_id
                      }
                    ]),
                ...replacedEvents,
                {
                  event: {
                    type: "RUN_FINISHED",
                    run_id: run.run_id,
                    session_id: run.session_id,
                    turn_id: run.turn_id,
                    message_count: projection.length,
                    ...runTotals(valid.usage, valid.lastInputTokens)
                  } satisfies ChatProjectionEvent,
                  runId: run.run_id
                }
              ]
            })
            .pipe(
              Effect.mapError((cause) =>
                writeError("finish", "storage", "Could not commit terminal events", {
                  sessionId: run.session_id,
                  runId: run.run_id,
                  cause
                })
              )
            )
          yield* sql`
          UPDATE chat_runs
          SET status = 'completed', stop_reason = ${valid.stopReason ?? null}, updated_at = ${timestamp},
              ended_at = ${timestamp}, error_code = NULL, error_message = NULL,
              metadata_json = json_set(
                metadata_json,
                '$.terminal_result',
                json(${terminalResultJson})
              )
          WHERE run_id = ${run.run_id}
        `
          if (valid.result !== undefined) yield* recordFinalRunUsage(sql, run.run_id)
          yield* sql`
          UPDATE chat_idempotency_keys
          SET status = 'completed', updated_at = ${timestamp}
          WHERE session_id = ${run.session_id} AND client_id = ${run.client_id}
        `
          yield* setCheckpoint(
            sql,
            chatEvents,
            run.session_id,
            run.run_id,
            committed.headSequence,
            "finish"
          )
          yield* appendRunSettledInTransaction(sql, sessionEvents, run.run_id)
          yield* sessionEvents.appendInTransaction("session_activity", run.session_id)
          const reply = typeof assistantMessage.content === "string" ? assistantMessage.content : ""
          yield* settleRun(
            { sql, sessionEvents, chatEvents },
            { runId: run.run_id, now: timestamp, terminal: { status: "completed", result: reply } }
          )
          return {
            _tag: "Completed",
            committed
          } satisfies ChatWriteFinishResult
        })
      )
      .pipe(Effect.mapError(mapFailure("finish", { runId: valid.runId })))
  })
  return finish
}
