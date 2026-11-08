import { Effect } from "effect"
import type { ChatWriteError } from "../chat/store.js"
import type { ToolExecutionStoreError } from "../tools/store.js"
import type { SqlClient } from "effect/unstable/sql"
import type { StoredMessageEnvelope } from "../transcript/model.js"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import type { UnitOfWork } from "../unit-of-work.js"
import { writeError } from "./chat-write-errors.js"
import { recoverTerminalToolMessages } from "./tool-transcript.js"
import {
  loadSettledRunToolExecutionsInTransaction,
  markRunToolExecutionsUncertainInTransaction,
  settleUnstartedToolWorkForTerminalInTransaction,
  type RunEnding
} from "./tool-receipts.js"
import { messageTurnIdSql } from "./message-turns.js"

export const settleTerminalToolsInTransaction = Effect.fn("Chat.settleTerminalTools")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly operation: "finish" | "fail" | "cancel"
    readonly sessionId: string
    readonly runId: string
    readonly turnId: string
    readonly terminalAt: string
    readonly ending: RunEnding
    readonly activeMessages: ReadonlyArray<StoredMessageEnvelope>
    readonly appendedMessages: ReadonlyArray<StoredMessageEnvelope>
    readonly sessionEvents: Pick<SessionLifecycleEvents["Service"], "appendEventInTransaction">
  }
): Effect.fn.Return<
  ReadonlyArray<StoredMessageEnvelope>,
  ChatWriteError | ToolExecutionStoreError,
  UnitOfWork
> {
  yield* markRunToolExecutionsUncertainInTransaction(
    sql,
    input.runId,
    input.terminalAt,
    input.ending
  )
  const terminal = { finish: "completed", fail: "failed", cancel: "cancelled" } as const
  yield* settleUnstartedToolWorkForTerminalInTransaction(
    sql,
    input.runId,
    input.terminalAt,
    terminal[input.operation]
  )
  const owned = yield* sql<{ readonly message_id: string }>`
      SELECT message_id FROM session_messages
      WHERE session_id = ${input.sessionId}
        -- From the turn's first message (session_turns), not the whole chat;
        -- the whole chat only when the turn has no row.
        AND seq >= COALESCE((
          SELECT message_start_seq FROM session_turns
          WHERE session_id = ${input.sessionId} AND turn_id = ${input.turnId}
        ), 0)
        AND ${messageTurnIdSql(sql, "session_messages")} = ${input.turnId}
    `.pipe(
    Effect.mapError((cause) =>
      writeError(input.operation, "storage", "Could not load terminal tool message ownership", {
        sessionId: input.sessionId,
        runId: input.runId,
        cause
      })
    )
  )
  const ids = new Set(owned.map((row) => row.message_id))
  const executions = yield* loadSettledRunToolExecutionsInTransaction(sql, input.runId)
  return yield* recoverTerminalToolMessages({
    ...input,
    activeMessages: [
      ...input.activeMessages.filter((message) => ids.has(message.message_id)),
      ...input.appendedMessages
    ],
    executions
  })
})
