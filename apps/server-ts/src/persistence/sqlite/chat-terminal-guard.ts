import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { ChatWriteConflictError, type ChatWriteError } from "../chat/store.js"
import type { RunRow } from "./chat-run.js"
import { writeError } from "./chat-write-errors.js"
import { outToolStatusList } from "./status-sets.js"

export const rejectUncertainMutationTerminal = Effect.fn(
  "SqliteChatWriteStore.rejectUncertainMutationTerminal"
)(function* (
  sql: SqlClient.SqlClient,
  run: RunRow,
  operation: "fail" | "cancel"
): Effect.fn.Return<void, ChatWriteError | ChatWriteConflictError> {
  if (run.client_id === null) {
    return yield* writeError(operation, "corrupt", "Chat run has no client id", {
      sessionId: run.session_id,
      runId: run.run_id
    })
  }
  const rows = yield* sql<{ readonly present: number }>`
    SELECT 1 AS present
    FROM tool_calls AS call
    WHERE call.run_id = ${run.run_id}
      AND call.status IN ${outToolStatusList}
      AND call.changes_state = 1
    LIMIT 1
  `.pipe(
    Effect.mapError((cause) =>
      writeError(operation, "storage", "Could not inspect unresolved tool work", {
        sessionId: run.session_id,
        runId: run.run_id,
        cause
      })
    )
  )
  if (rows.length > 0) {
    return yield* new ChatWriteConflictError({
      sessionId: run.session_id,
      clientId: run.client_id,
      message: "Resolve the state-changing tool outcome before stopping this run"
    })
  }
})
