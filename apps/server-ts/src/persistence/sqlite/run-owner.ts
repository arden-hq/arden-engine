import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { NESTING } from "../tools/tool-roles.js"

export const scriptOwnsRun = Effect.fn("RunOwner.scriptOwnsRun")(function* (
  sql: SqlClient.SqlClient,
  runId: string
) {
  const rows = yield* sql<{ readonly present: number }>`
    SELECT 1 AS present
    FROM chat_runs AS run
    JOIN sessions AS child ON child.session_id = run.session_id
    JOIN code_mode_scripts AS script ON script.origin_run_id = child.parent_run_id
    JOIN tool_calls AS spawn ON spawn.run_id = child.parent_run_id
      AND spawn.tool_call_id = child.parent_tool_call_id
      AND spawn.parent_tool_call_id = script.origin_tool_call_id
      AND spawn.nesting = ${NESTING.workflow}
    JOIN script_agent_calls AS agent ON agent.run_id = spawn.run_id
      AND agent.tool_call_id = spawn.tool_call_id
    WHERE run.run_id = ${runId}
      AND run.client_id = 'spawn:' || child.parent_run_id || ':' || child.parent_tool_call_id
    LIMIT 1
  `
  return rows.length > 0
})
