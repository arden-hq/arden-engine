import { loadRun, loadActiveRun, requireReceiptForRun, setCheckpoint } from "./chat-run.js"
import { textEnd } from "./recovery-finish.js"
import { appendMessagesInTransaction, loadActiveMessages } from "./chat-transcript.js"
import { announceAnswers, loadPendingInTransaction } from "./chat-pending.js"
import { mapFailure, validateInput, writeError } from "./chat-write-errors.js"
import { fenceRunCancellation } from "./run-cancellation.js"
import type { ChatProjectionEvent } from "@arden-hq/protocol"
import { settleRun } from "./run-settle.js"
import { recordFinalRunUsage } from "./run-usage.js"
import { RunCancelTargetSchema, type RunCancelTarget } from "../chat/send-contracts.js"
import { StoredRunTerminalResultSchema as RunTerminalResultSchema } from "../runs/stored-result.js"
import { DateTime, Effect, Schema } from "effect"
import { ChatWriteStore, type ChatWriteCancelResult, type ChatWriteFailure } from "../chat/store.js"
import { settleTerminalToolsInTransaction } from "./tool-terminal.js"
import { type PersistenceDeps } from "./deps.js"
import { appendRunSettledInTransaction } from "./run-settled.js"
import { isTerminalRunStatus } from "@arden-hq/protocol/runs"
import { turnTouchesRecencySql } from "./session-unread.js"
import { makeChatFinish } from "./chat-finish.js"
import { makeChatFail } from "./chat-fail.js"

export const makeChatTerminal = ({
  writer,
  chatEvents,
  sessionEvents
}: Pick<PersistenceDeps, "writer" | "chatEvents" | "sessionEvents">): Pick<
  ChatWriteStore["Service"],
  "finish" | "fail" | "cancel" | "recordLateOutcome"
> => {
  const sql = writer.sql
  const recordLateOutcome: ChatWriteStore["Service"]["recordLateOutcome"] = Effect.fn(
    function* (input) {
      const valid = yield* validateInput(
        Schema.Struct({ runId: Schema.NonEmptyString, result: RunTerminalResultSchema }),
        input,
        "finish"
      )
      const timestamp = DateTime.formatIso(yield* DateTime.now)
      yield* writer
        .transactInteractive(
          Effect.gen(function* () {
            const run = yield* loadRun(sql, valid.runId, "finish")
            if (!isTerminalRunStatus(run.status))
              return yield* writeError("finish", "invalid", "Late outcomes require a terminal Run")
            const rows = yield* sql<{ readonly result: string | null }>`
        SELECT json_extract(metadata_json, '$.terminal_result') AS result FROM chat_runs WHERE run_id = ${valid.runId}
      `
            const result = JSON.stringify(valid.result)
            if (rows[0]?.result !== null && rows[0]?.result !== undefined) {
              if (rows[0].result === result) return
              return yield* writeError(
                "finish",
                "terminal",
                "This Run already has a different final result"
              )
            }
            yield* sql`UPDATE chat_runs SET metadata_json = json_set(metadata_json,
          '$.terminal_result', json(${result}), '$.late_result_at', ${timestamp}), updated_at = ${timestamp}
        WHERE run_id = ${valid.runId}`
            yield* sql`UPDATE automation_runs SET result = ${valid.result.text} WHERE chat_run_id = ${valid.runId}`
            yield* recordFinalRunUsage(sql, valid.runId)
            const session = yield* sql`SELECT 1 FROM sessions WHERE session_id = ${run.session_id}`
            if (session.length > 0)
              yield* sessionEvents.appendInTransaction("session_activity", run.session_id)
          })
        )
        .pipe(Effect.mapError(mapFailure("finish", { runId: valid.runId })))
    }
  )

  const finish = makeChatFinish({ writer, chatEvents, sessionEvents })
  const fail = makeChatFail({ writer, chatEvents, sessionEvents })
  const cancel = Effect.fn("SqliteChatWriteStore.cancel")(function* (
    input: RunCancelTarget
  ): Effect.fn.Return<ChatWriteCancelResult, ChatWriteFailure> {
    yield* validateInput(RunCancelTargetSchema, input, "cancel")
    const target = input
    const now = yield* DateTime.now
    const timestamp = DateTime.formatIso(now)

    return yield* writer
      .transactInteractive(
        Effect.gen(function* () {
          const run = yield* loadActiveRun(sql, target)
          yield* requireReceiptForRun(sql, run, "cancel")
          const fenced = yield* fenceRunCancellation({
            sql,
            sessionEvents,
            runId: run.run_id,
            now: timestamp
          })
          const pending = yield* loadPendingInTransaction(sql, run, "cancel")
          const activeMessages = yield* loadActiveMessages(sql, run.session_id, "cancel")
          const recoveredTools = yield* settleTerminalToolsInTransaction(sql, {
            ending: "run_ended",
            operation: "cancel",
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
              "cancel",
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
                    type: "run_cancelled",
                    run_id: run.run_id,
                    session_id: run.session_id,
                    turn_id: run.turn_id
                  } satisfies ChatProjectionEvent,
                  runId: run.run_id
                }
              ]
            })
            .pipe(
              Effect.mapError((cause) =>
                writeError("cancel", "storage", "Could not commit cancellation", {
                  sessionId: run.session_id,
                  runId: run.run_id,
                  cause
                })
              )
            )
          yield* sql`
        UPDATE chat_runs
        SET status = 'cancelled', stop_reason = 'cancelled', updated_at = ${timestamp},
            ended_at = ${timestamp}, error_code = NULL, error_message = NULL
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
        SET status = 'cancelled', updated_at = ${timestamp}
        WHERE session_id = ${run.session_id}
          AND (client_id = ${run.client_id} OR (run_id = ${run.run_id} AND status = 'queued'))
      `
          yield* setCheckpoint(
            sql,
            chatEvents,
            run.session_id,
            run.run_id,
            committed.headSequence,
            "cancel"
          )
          yield* appendRunSettledInTransaction(sql, sessionEvents, run.run_id)
          yield* sessionEvents.appendInTransaction("session_activity", run.session_id)
          yield* settleRun(
            { sql, sessionEvents, chatEvents },
            { runId: run.run_id, now: timestamp, terminal: { status: "cancelled" } }
          )
          return {
            runId: run.run_id,
            sessionId: run.session_id,
            descendantRunIds: fenced.activeRunIds.filter((runId) => runId !== run.run_id),
            committed
          } satisfies ChatWriteCancelResult
        })
      )
      .pipe(
        Effect.mapError(
          mapFailure("cancel", {
            ...(target.runId === undefined ? {} : { runId: target.runId }),
            ...(target.sessionId === undefined ? {} : { sessionId: target.sessionId })
          })
        )
      )
  })

  return { finish, fail, cancel, recordLateOutcome }
}
