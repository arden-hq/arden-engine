import { Effect } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import { userAutomationSql } from "./authority-sql.js"

interface CopySource {
  readonly sessionId: string
  readonly automationId: string
  readonly approvalMode: string | undefined
}

const copySourceRows = (sql: SqlClient.SqlClient, sessionId: Statement.Fragment) => sql`
  SELECT source.session_id, copy.origin_automation_id AS automation_id,
      json_extract(source.metadata, '$.approval_mode') AS approval_mode
    FROM sessions AS copy
    JOIN scheduled_tasks AS automation ON automation.task_id = copy.origin_automation_id
    JOIN sessions AS source
      ON source.session_id = COALESCE(
        json_extract(copy.metadata, '$.fork_origin.sourceSessionId'),
        json_extract(copy.metadata, '$.fork_of.source_session_id'))
    WHERE copy.session_id = ${sessionId} AND copy.session_type = 'chat'
      AND copy.parent_session_id IS NOT NULL AND ${userAutomationSql("automation")}`

export const readCopySource = Effect.fn("AutomationCopy.source")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string
) {
  const rows = yield* sql<{
    readonly session_id: string
    readonly automation_id: string
    readonly approval_mode: string | null
  }>`${copySourceRows(sql, sql`${sessionId}`)}`
  const row = rows[0]
  return row === undefined
    ? undefined
    : ({
        sessionId: row.session_id,
        automationId: row.automation_id,
        approvalMode: row.approval_mode ?? undefined
      } satisfies CopySource)
})
