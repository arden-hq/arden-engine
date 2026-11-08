import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { decodeRunApproval, type ApprovalRow } from "./run-approvals.js"
import { workError } from "./work-records.js"
import { pendingDecisionCards } from "./pending-decision-cards.js"
import { taskOpenSql } from "./task-status-sql.js"

export const readTaskApprovals = Effect.fn("readTaskApprovals")(function* (
  sql: SqlClient.SqlClient,
  itemIds: ReadonlyArray<string>
) {
  if (itemIds.length === 0) return []
  const rows = yield* sql<ApprovalRow & { readonly item_id: string }>`
    SELECT task.item_id, approval.destination_session_id, approval.work_json, approval.run_id, approval.session_id, approval.tool_call_id,
           approval.tool_name, approval.action, approval.scope, approval.preview,
           approval.diff, approval.requested_at, approval.kind, approval.payload_json,
           approval.source
    FROM space_tasks AS task
    JOIN chat_runs AS run ON json_extract(run.metadata_json, '$.run_context.task.item_id') = task.item_id
      AND json_extract(run.metadata_json, '$.run_context.task.generation') = task.generation
    JOIN (${pendingDecisionCards(sql)}) AS approval ON approval.run_id = run.run_id
    WHERE task.item_id IN ${sql.in(itemIds)} AND ${taskOpenSql("task")}
    ORDER BY approval.requested_at, approval.run_id, approval.tool_call_id
  `.pipe(Effect.mapError((cause) => workError("storage", "Could not read Task approvals", cause)))
  return yield* Effect.forEach(rows, (row) =>
    decodeRunApproval(row).pipe(
      Effect.map((approval) => ({ ...approval, item_id: row.item_id })),
      Effect.mapError((cause) => workError("storage", "Stored Task approval is corrupt", cause))
    )
  )
})
