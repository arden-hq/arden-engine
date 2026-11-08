import { DateTime, Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import { revokeAutomationWork } from "./automation-authority.js"
import { userAutomationSql } from "./authority-sql.js"

export const deleteAutomationRow = Effect.fn("AutomationRemoval.delete")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly sessionEvents: SessionLifecycleEvents["Service"]
  readonly automationId: string
  readonly settlingRunId?: string | undefined
}) {
  const { sql, automationId } = options
  yield* revokeAutomationWork({
    sql,
    sessionEvents: options.sessionEvents,
    automationId,
    settlingRunId: options.settlingRunId
  })
  yield* sql`DELETE FROM automation_event_queue WHERE task_id = ${automationId}`
  yield* sql`DELETE FROM automation_event_dedupe WHERE task_id = ${automationId}`
  yield* sql`DELETE FROM automation_count_state WHERE task_id = ${automationId}`
  yield* sql`DELETE FROM scheduled_tasks WHERE task_id = ${automationId}`
  yield* sql`UPDATE sessions SET archived_at = COALESCE(archived_at, ${DateTime.formatIso(yield* DateTime.now)}),
      metadata = json_remove(metadata, '$.archived_with_space')
    WHERE origin_automation_id = ${automationId} AND session_type = 'channel'
      AND (archived_at IS NULL OR json_extract(metadata, '$.archived_with_space') = 1)`
})

export const automationsOfChat = (sql: SqlClient.SqlClient, sessionId: string) =>
  sql<{
    readonly task_id: string
    readonly name: string
    readonly running: number
  }>`SELECT task_id, name, (running_since IS NOT NULL OR EXISTS (
        SELECT 1 FROM automation_runs AS run
        WHERE run.task_id = task.task_id AND run.status = 'running')) AS running
      FROM scheduled_tasks AS task
      WHERE thread_id = ${sessionId} AND ${userAutomationSql()}
      ORDER BY task_id`

export const deleteAutomationsOfChat = Effect.fn("AutomationRemoval.ofChat")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly sessionEvents: SessionLifecycleEvents["Service"]
  readonly sessionId: string
}) {
  const automations = yield* automationsOfChat(options.sql, options.sessionId)
  const running = automations.filter((automation) => automation.running !== 0)
  if (running.length > 0)
    return { kind: "running", names: running.map((automation) => automation.name) } as const
  for (const automation of automations)
    yield* deleteAutomationRow({ ...options, automationId: automation.task_id })
  return { kind: "deleted", names: automations.map((automation) => automation.name) } as const
})
