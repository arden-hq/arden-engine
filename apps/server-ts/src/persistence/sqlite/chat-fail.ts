import { loadRun, requireReceiptForRun, setCheckpoint } from "./chat-run.js"
import { textEnd } from "./recovery-finish.js"
import { appendMessagesInTransaction, loadActiveMessages } from "./chat-transcript.js"
import { announceAnswers, loadPendingInTransaction } from "./chat-pending.js"
import { mapFailure, validateInput, writeError } from "./chat-write-errors.js"
import type { ChatProjectionEvent } from "@arden-hq/protocol"
import { settleRun } from "./run-settle.js"
import { rejectUncertainMutationTerminal } from "./chat-terminal-guard.js"
import { ChatRunErrorCodeSchema } from "@arden-hq/protocol/effect/chat"
import { DateTime, Effect, Schema } from "effect"
import {
  type ChatWriteFailInput,
  type ChatWriteFailure,
  type ChatWriteTerminalResult,
  type ChatWriteStore
} from "../chat/store.js"
import { settleTerminalToolsInTransaction } from "./tool-terminal.js"
import { type PersistenceDeps } from "./deps.js"
import { appendRunSettledInTransaction } from "./run-settled.js"
import { isTerminalRunStatus } from "@arden-hq/protocol/runs"
import { turnTouchesRecencySql } from "./session-unread.js"

const failInputSchema = Schema.Struct({
  runId: Schema.NonEmptyString,
  code: ChatRunErrorCodeSchema,
  message: Schema.NonEmptyString
})

export const makeChatFail = ({
  writer,
  chatEvents,
  sessionEvents
}: Pick<
  PersistenceDeps,
  "writer" | "chatEvents" | "sessionEvents"
>): ChatWriteStore["Service"]["fail"] => {
  const sql = writer.sql
  const fail = Effect.fn("SqliteChatWriteStore.fail")(function* (
    input: ChatWriteFailInput
  ): Effect.fn.Return<ChatWriteTerminalResult, ChatWriteFailure> {
    const valid = yield* validateInput(failInputSchema, input, "fail")
    const now = yield* DateTime.now
    const timestamp = DateTime.formatIso(now)

    return yield* writer
      .transactInteractive(
        Effect.gen(function* () {
          const run = yield* loadRun(sql, valid.runId, "fail")
          if (isTerminalRunStatus(run.status)) {
            return yield* writeError("fail", "terminal", "Chat run is already terminal", {
              sessionId: run.session_id,
              runId: run.run_id
            })
          }
          yield* requireReceiptForRun(sql, run, "fail")
          yield* rejectUncertainMutationTerminal(sql, run, "fail")
          const pending = yield* loadPendingInTransaction(sql, run, "fail")
          const activeMessages = yield* loadActiveMessages(sql, run.session_id, "fail")
          const recoveredTools = yield* settleTerminalToolsInTransaction(sql, {
            ending: "run_ended",
            operation: "fail",
            sessionId: run.session_id,
            runId: run.run_id,
            turnId: run.turn_id,
            terminalAt: timestamp,
            activeMessages,
            appendedMessages: [],
            sessionEvents
          })
          const terminalMessages = [...recoveredTools, ...pending.messages]
          if (terminalMessages.length > 0) {
            yield* appendMessagesInTransaction(
              sql,
              run.session_id,
              terminalMessages,
              timestamp,
              "fail",
              run.turn_id
            )
            yield* announceAnswers({ sql, sessionEvents, messages: pending.messages })
          }
          const committed = yield* chatEvents
            .appendInTransaction({
              sessionId: run.session_id,
              events: [
                ...(terminalMessages.length === 0
                  ? []
                  : [
                      {
                        event: { type: "transcript_changed" } satisfies ChatProjectionEvent,
                        runId: run.run_id
                      }
                    ]),
                {
                  event: textEnd(run.assistant_message_id, run.session_id, undefined),
                  runId: run.run_id
                },
                {
                  event: {
                    type: "RUN_ERROR",
                    run_id: run.run_id,
                    session_id: run.session_id,
                    turn_id: run.turn_id,
                    code: valid.code,
                    message: valid.message
                  } satisfies ChatProjectionEvent,
                  runId: run.run_id
                }
              ]
            })
            .pipe(
              Effect.mapError((cause) =>
                writeError("fail", "storage", "Could not commit terminal events", {
                  sessionId: run.session_id,
                  runId: run.run_id,
                  cause
                })
              )
            )
          yield* sql`
        UPDATE chat_runs
        SET status = 'error', stop_reason = ${valid.code}, updated_at = ${timestamp},
            ended_at = ${timestamp},
            error_code = ${valid.code}, error_message = ${valid.message}
        WHERE run_id = ${run.run_id}
      `
          yield* sql`
        UPDATE sessions
        SET last_activity = CASE
              WHEN ${turnTouchesRecencySql(sql, { sessionId: run.session_id, turnId: run.turn_id })}
              THEN ${timestamp} ELSE last_activity END
        WHERE session_id = ${run.session_id}
      `
          yield* sql`
        UPDATE chat_idempotency_keys
        SET status = 'error', updated_at = ${timestamp}
        WHERE session_id = ${run.session_id}
          AND (client_id = ${run.client_id} OR (run_id = ${run.run_id} AND status = 'queued'))
      `
          yield* setCheckpoint(
            sql,
            chatEvents,
            run.session_id,
            run.run_id,
            committed.headSequence,
            "fail"
          )
          yield* appendRunSettledInTransaction(sql, sessionEvents, run.run_id)
          yield* sessionEvents.appendInTransaction("session_activity", run.session_id)
          yield* settleRun(
            { sql, sessionEvents, chatEvents },
            {
              runId: run.run_id,
              now: timestamp,
              terminal: { status: "failed", error: valid.message }
            }
          )
          return { committed }
        })
      )
      .pipe(Effect.mapError(mapFailure("fail", { runId: valid.runId })))
  })
  return fail
}
