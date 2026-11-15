import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  const retired = database
    .prepare("SELECT task_id FROM scheduled_tasks WHERE handler = 'report_retention'")
    .all()
  for (const row of retired) {
    const automationId = String(row.task_id)
    for (const table of [
      "automation_event_queue",
      "automation_event_dedupe",
      "automation_count_state"
    ])
      database.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(automationId)
    database
      .prepare(
        `UPDATE sessions SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE origin_automation_id = ? AND session_type = 'channel' AND archived_at IS NULL`
      )
      .run(automationId)
    database.prepare("DELETE FROM scheduled_tasks WHERE task_id = ?").run(automationId)
  }
}

export const reportRetentionRetired: Migration = {
  version: 163,
  name: "report_retention_retired",
  foreignKeys: { kind: "enforced" },
  up
}
