import type { ChatProjectionEvent } from "@arden-hq/protocol"
import { isConversationalInput } from "@arden-hq/loop"
import { isForegroundRunStatus } from "@arden-hq/protocol/runs"
import { DateTime, Effect, Schema } from "effect"
import type {
  ChatWriteStore,
  ChatWriteCheckpointInput,
  ChatWriteFailure,
  ChatCheckpointAnchor
} from "../chat/store.js"
import { StoredMessageEnvelopeSchema, type StoredMessageEnvelope } from "../transcript/model.js"
import { loadRun, setCheckpoint } from "./chat-run.js"
import { announceAnswers, loadPendingInTransaction, markPendingIngested } from "./chat-pending.js"
import { mapFailure, validateInput, writeError } from "./chat-write-errors.js"
import { appendChatEventsInTransaction, findChatEvents, lookError } from "./chat-events.js"
import {
  MessageListSchema,
  appendMessagesInTransaction,
  hasToolIntent,
  historyTail,
  appendedHistoryTail,
  loadLastActiveMessageFor,
  rejectTranscriptIds
} from "./chat-transcript.js"
import type { PersistenceDeps } from "./deps.js"
import { transactWithActiveContext } from "./active-context-stage.js"
import { isActiveRunStatus } from "@arden-hq/protocol/runs"
import { turnTouchesRecencySql } from "./session-unread.js"

const checkpointInputSchema = Schema.Struct({
  runId: Schema.NonEmptyString,
  completionMessageId: Schema.optionalKey(Schema.NonEmptyString),
  messages: Schema.Array(Schema.Struct({ message_id: Schema.NonEmptyString })),
  appendFrom: Schema.optionalKey(
    Schema.Struct({
      contextGeneration: Schema.Natural,
      activeCount: Schema.Natural,
      lastMessage: Schema.NullOr(StoredMessageEnvelopeSchema)
    })
  ),
  eventSequence: Schema.optionalKey(Schema.Natural),
  lastInputTokens: Schema.optionalKey(Schema.Natural)
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

export const makeChatCheckpoint = ({
  writer,
  chatEvents,
  sessionEvents
}: Pick<PersistenceDeps, "writer" | "chatEvents" | "sessionEvents">): Pick<
  ChatWriteStore["Service"],
  "drainPending" | "peekPendingInput" | "checkpoint"
> => {
  const sql = writer.sql
  const peekPendingInput = Effect.fn("SqliteChatWriteStore.peekPendingInput")(function* (
    runId: string
  ): Effect.fn.Return<boolean, ChatWriteFailure> {
    return yield* writer
      .snapshot(
        Effect.gen(function* () {
          const run = yield* loadRun(writer.reader, runId, "drain")
          if (!isForegroundRunStatus(run.status)) return false
          const pending = yield* loadPendingInTransaction(writer.reader, run, "drain")
          return pending.messages.some(isConversationalInput)
        })
      )
      .pipe(Effect.mapError(mapFailure("drain", { runId })))
  })
  const drainPending = Effect.fn("SqliteChatWriteStore.drainPending")(function* (
    runIdInput: string
  ): Effect.fn.Return<ReadonlyArray<StoredMessageEnvelope>, ChatWriteFailure> {
    const runId = yield* validateInput(Schema.NonEmptyString, runIdInput, "drain")
    const now = yield* DateTime.now
    const timestamp = DateTime.formatIso(now)

    return yield* transactWithActiveContext(
      writer,
      "interactive",
      { runId },
      Effect.gen(function* () {
        const run = yield* loadRun(sql, runId, "drain")
        if (!isForegroundRunStatus(run.status)) {
          return []
        }
        const pending = yield* loadPendingInTransaction(sql, run, "drain")
        const look =
          run.automation_context_mode === "fresh"
            ? undefined
            : yield* findChatEvents(sql, { sessionId: run.session_id, now }).pipe(
                Effect.mapError(lookError("drain", run.session_id))
              )
        const news = look?.batch === undefined ? undefined : look
        if (pending.events.length === 0 && news === undefined) {
          return pending.messages
        }
        // A resumed tool result must checkpoint before injected user input.
        // Otherwise the durable prefix can place that input between the call
        // and its output, which neither the next checkpoint nor OpenAI accepts.
        if (hasToolIntent(yield* loadLastActiveMessageFor(sql, run.session_id, "drain"))) {
          return []
        }
        if (news !== undefined) {
          yield* appendChatEventsInTransaction(sql, {
            sessionId: run.session_id,
            look: news,
            now,
            operation: "drain",
            turnId: run.turn_id
          })
        }
        const applied = pending.messages.map((message) => ({ ...message, applied_at: timestamp }))
        yield* appendMessagesInTransaction(
          sql,
          run.session_id,
          applied,
          timestamp,
          "drain",
          run.turn_id
        )
        yield* markPendingIngested(sql, run, timestamp, "drain")
        const committed = yield* chatEvents
          .appendInTransaction({
            sessionId: run.session_id,
            events: [
              ...pending.events.map((entry) => ({
                ...entry,
                event: { ...entry.event, applied_at: timestamp } satisfies ChatProjectionEvent
              })),
              {
                event: { type: "transcript_changed" } satisfies ChatProjectionEvent,
                runId: run.run_id
              }
            ]
          })
          .pipe(
            Effect.mapError((cause) =>
              writeError("drain", "storage", "Could not commit pending-message events", {
                sessionId: run.session_id,
                runId: run.run_id,
                cause
              })
            )
          )
        yield* setCheckpoint(
          sql,
          chatEvents,
          run.session_id,
          run.run_id,
          committed.headSequence,
          "drain"
        )
        yield* sessionEvents.appendInTransaction("session_activity", run.session_id)
        yield* announceAnswers({ sql, sessionEvents, messages: applied })
        return news?.batch === undefined ? applied : [news.batch.message, ...applied]
      })
    ).pipe(Effect.mapError(mapFailure("drain", { runId })))
  })

  const checkpoint = Effect.fn("SqliteChatWriteStore.checkpoint")(function* (
    input: ChatWriteCheckpointInput
  ): Effect.fn.Return<ChatCheckpointAnchor, ChatWriteFailure> {
    const valid = yield* validateInput(checkpointInputSchema, input, "checkpoint")
    const now = yield* DateTime.now
    const timestamp = DateTime.formatIso(now)

    return yield* transactWithActiveContext(
      writer,
      "interactive",
      { runId: valid.runId },
      Effect.gen(function* () {
        const run = yield* loadRun(sql, valid.runId, "checkpoint")
        if (!isActiveRunStatus(run.status)) {
          return yield* writeError("checkpoint", "invalid", "Chat run is not active", {
            sessionId: run.session_id,
            runId: run.run_id
          })
        }
        const tail =
          valid.appendFrom === undefined
            ? yield* historyTail(
                sql,
                { sessionId: run.session_id, runId: run.run_id },
                input.messages,
                "checkpoint"
              )
            : yield* appendedHistoryTail(
                sql,
                { sessionId: run.session_id, runId: run.run_id },
                valid.appendFrom,
                input.messages
              )
        const appended = yield* validateInput(MessageListSchema, tail, "checkpoint")
        yield* rejectTranscriptIds(sql, run, appended, "checkpoint")
        if (appended.some((message) => message.role === "system")) {
          return yield* writeError(
            "checkpoint",
            "invalid",
            "Chat history cannot append system messages",
            {
              sessionId: run.session_id,
              runId: run.run_id
            }
          )
        }
        const checkpointRows =
          valid.eventSequence === undefined
            ? []
            : yield* sql<{ readonly checkpoint_seq: number }>`
              SELECT checkpoint_seq
              FROM session_event_checkpoints
              WHERE session_id = ${run.session_id}
              LIMIT 1
            `
        const nextCheckpoint = valid.eventSequence ?? 0
        const advancesCheckpoint =
          valid.eventSequence !== undefined &&
          nextCheckpoint > (checkpointRows[0]?.checkpoint_seq ?? 0)
        yield* appendMessagesInTransaction(
          sql,
          run.session_id,
          appended,
          timestamp,
          "checkpoint",
          run.turn_id
        )
        if (valid.completionMessageId !== undefined) {
          const last =
            appended.at(-1) ?? (yield* loadLastActiveMessageFor(sql, run.session_id, "checkpoint"))
          if (
            last?.message_id !== valid.completionMessageId ||
            (last.role !== "tool" && (last.role !== "assistant" || hasToolIntent(last)))
          ) {
            return yield* writeError(
              "checkpoint",
              "invalid",
              "Completion must identify the final assistant or turn-ending tool checkpoint tail",
              { runId: run.run_id }
            )
          }
          yield* sql`UPDATE chat_runs SET completion_message_id = ${valid.completionMessageId}
              WHERE run_id = ${run.run_id}`
        }
        if (appended.length === 0 && advancesCheckpoint) {
          yield* sql`
            UPDATE sessions
            SET last_activity = CASE
              WHEN ${turnTouchesRecencySql(sql, { sessionId: run.session_id, turnId: run.turn_id })}
              THEN ${timestamp} ELSE last_activity END
            WHERE session_id = ${run.session_id}
          `
        }
        if (valid.lastInputTokens !== undefined && valid.lastInputTokens > 0) {
          yield* sql`
            UPDATE sessions
            SET metadata = json_set(COALESCE(metadata, '{}'), '$.last_input_tokens', ${valid.lastInputTokens})
            WHERE session_id = ${run.session_id}
          `.pipe(
            Effect.mapError((cause) =>
              writeError("checkpoint", "storage", "Could not update session context usage", {
                sessionId: run.session_id,
                runId: run.run_id,
                cause
              })
            )
          )
        }
        if (advancesCheckpoint) {
          yield* setCheckpoint(
            sql,
            chatEvents,
            run.session_id,
            run.run_id,
            nextCheckpoint,
            "checkpoint"
          )
        }
        if (appended.length > 0 || advancesCheckpoint) {
          yield* sessionEvents.appendInTransaction("session_activity", run.session_id)
        }
        const state = yield* sql<{
          readonly context_generation: number
          readonly active_message_count: number
        }>`
            SELECT context_generation, active_message_count FROM sessions
            WHERE session_id = ${run.session_id}
          `
        const current = state[0]
        if (current === undefined) {
          return yield* writeError("checkpoint", "invalid", "Chat session no longer exists", {
            runId: run.run_id
          })
        }
        return {
          contextGeneration: current.context_generation,
          activeCount: current.active_message_count,
          lastMessage: (yield* loadLastActiveMessageFor(sql, run.session_id, "checkpoint")) ?? null
        }
      })
    ).pipe(Effect.mapError(mapFailure("checkpoint", { runId: valid.runId })))
  })

  return { drainPending, peekPendingInput, checkpoint }
}
