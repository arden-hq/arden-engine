import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { parseScriptChildId } from "./script-derive.js"

export const scriptOwnsRun = Effect.fn("RunOwner.scriptOwnsRun")(function* (
  sql: SqlClient.SqlClient,
  runId: string
) {
  const rows = yield* sql<{
    readonly origin_tool_call_id: string
    readonly parent_tool_call_id: string
  }>`
    SELECT script.origin_tool_call_id, child.parent_tool_call_id
    FROM chat_runs AS run
    JOIN sessions AS child ON child.session_id = run.session_id
    JOIN code_mode_scripts AS script ON script.origin_run_id = child.parent_run_id
    WHERE run.run_id = ${runId}
      AND run.client_id = 'spawn:' || child.parent_run_id || ':' || child.parent_tool_call_id
  `
  return rows.some(
    (row) => parseScriptChildId(row.origin_tool_call_id, row.parent_tool_call_id) !== undefined
  )
})
