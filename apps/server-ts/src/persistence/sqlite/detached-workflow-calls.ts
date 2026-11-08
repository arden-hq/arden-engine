import { Effect } from "effect"
import type { SqlClient, SqlError } from "effect/unstable/sql"

import { DETACHED_WORKFLOW_OWNER_TOOLS } from "../tools/tool-roles.js"
import { workflowParentToolCallId } from "../tools/workflow-parent.js"
import { preserveToolError, toolError, type ToolOperation } from "./tool-rows.js"

export const requireLiveWorkflowOwner = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  identity: { readonly runId: string; readonly toolCallId: string },
  operation: ToolOperation
) {
  const owner = workflowParentToolCallId(identity.toolCallId)
  if (owner === undefined) return
  const rows = yield* sql<{ readonly status: string }>`
    SELECT status FROM code_mode_scripts
    WHERE origin_run_id = ${identity.runId} AND origin_tool_call_id = ${owner}
  `.pipe(Effect.mapError(preserveToolError(operation, identity)))
  if (rows[0] !== undefined && rows[0].status !== "running")
    return yield* toolError(operation, "conflict", "The owning script has stopped", identity)
})

export const detachedWorkflowCalls = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  runId: string,
  toolCallIds: ReadonlyArray<string>
): Effect.fn.Return<ReadonlySet<string>, SqlError.SqlError> {
  const owners = new Map(
    toolCallIds.flatMap((id) => {
      const owner = workflowParentToolCallId(id)
      return owner === undefined ? [] : [[id, owner] as const]
    })
  )
  if (owners.size === 0) return new Set()
  const rows = yield* sql<{ readonly tool_call_id: string }>`
    SELECT tool_call_id FROM tool_calls
    WHERE run_id = ${runId}
      AND tool_call_id IN ${sql.in([...new Set(owners.values())])}
      AND tool_name IN ${sql.in(DETACHED_WORKFLOW_OWNER_TOOLS)}
      AND ((status = 'completed' AND NOT EXISTS (
        SELECT 1 FROM code_mode_scripts AS script
        WHERE script.origin_run_id = tool_calls.run_id
          AND script.origin_tool_call_id = tool_calls.tool_call_id
      )) OR EXISTS (
        SELECT 1 FROM code_mode_scripts AS script
        WHERE script.origin_run_id = tool_calls.run_id
          AND script.origin_tool_call_id = tool_calls.tool_call_id
          AND script.status = 'running'
      ))
  `
  const completed = new Set(rows.map((row) => row.tool_call_id))
  return new Set([...owners].flatMap(([id, owner]) => (completed.has(owner) ? [id] : [])))
})
