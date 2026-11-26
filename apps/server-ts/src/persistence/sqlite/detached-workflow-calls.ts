import { TOOL_STATUS } from "./status-sets.js"
import { Effect } from "effect"
import type { SqlClient, SqlError, Statement } from "effect/unstable/sql"

import { DETACHED_WORKFLOW_OWNER_TOOLS, type NestingKind } from "../tools/tool-roles.js"
import { preserveToolError, toolError, type ToolOperation } from "./tool-rows.js"

const storedScripts = (
  sql: SqlClient.SqlClient,
  runId: string,
  toolCallIds: ReadonlyArray<string>
) =>
  sql<{ readonly tool_call_id: string; readonly script_tool_call_id: string }>`
    SELECT tool_call_id, script_tool_call_id FROM tool_calls
    WHERE run_id = ${runId} AND tool_call_id IN ${sql.in(toolCallIds)}
      AND script_tool_call_id IS NOT NULL`

export const requireLiveWorkflowOwner = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  identity: { readonly runId: string; readonly toolCallId: string },
  operation: ToolOperation,
  planned?: { readonly script: string | undefined }
) {
  const owner =
    planned === undefined
      ? (yield* storedScripts(sql, identity.runId, [identity.toolCallId]).pipe(
          Effect.mapError(preserveToolError(operation, identity))
        ))[0]?.script_tool_call_id
      : planned.script
  if (owner === undefined) return
  const rows = yield* sql<{ readonly status: string }>`
    SELECT status FROM code_mode_scripts
    WHERE origin_run_id = ${identity.runId} AND origin_tool_call_id = ${owner}
  `.pipe(Effect.mapError(preserveToolError(operation, identity)))
  if (rows[0] !== undefined && rows[0].status !== TOOL_STATUS.running)
    return yield* toolError(operation, "conflict", "The owning script has stopped", identity)
})

export const detachedOwnedCalls = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  runId: string,
  owners: ReadonlyMap<string, string>
): Effect.fn.Return<ReadonlySet<string>, SqlError.SqlError> {
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

export const detachedWorkflowCalls = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  runId: string,
  toolCallIds: ReadonlyArray<string>
): Effect.fn.Return<ReadonlySet<string>, SqlError.SqlError> {
  if (toolCallIds.length === 0) return new Set()
  const rows = yield* storedScripts(sql, runId, toolCallIds)
  return yield* detachedOwnedCalls(
    sql,
    runId,
    new Map(rows.map((row) => [row.tool_call_id, row.script_tool_call_id]))
  )
})

export const descendantCalls = (
  sql: SqlClient.SqlClient,
  runId: string | Statement.Fragment,
  ancestor: string | Statement.Fragment,
  firstNesting?: NestingKind
): Statement.Fragment => sql`(
  WITH RECURSIVE descendant(tool_call_id) AS (
    SELECT tool_call_id FROM tool_calls
    WHERE run_id = ${runId} AND parent_tool_call_id = ${ancestor}
      ${firstNesting === undefined ? sql`` : sql`AND nesting = ${firstNesting}`}
    UNION
    SELECT child.tool_call_id FROM tool_calls AS child
    JOIN descendant ON child.parent_tool_call_id = descendant.tool_call_id
    WHERE child.run_id = ${runId}
  )
  SELECT tool_call_id FROM descendant)`

export const descendantCallsOfColumns = (runId: string, ancestor: string): string => `(
  WITH RECURSIVE descendant(tool_call_id) AS (
    SELECT tool_call_id FROM tool_calls WHERE run_id = ${runId} AND parent_tool_call_id = ${ancestor}
    UNION
    SELECT child.tool_call_id FROM tool_calls AS child
    JOIN descendant ON child.parent_tool_call_id = descendant.tool_call_id
    WHERE child.run_id = ${runId}
  )
  SELECT tool_call_id FROM descendant)`
