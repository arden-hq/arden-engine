import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  const finished = database
    .prepare(
      `SELECT task.task_id FROM scheduled_tasks AS task
      JOIN automation_runs AS run ON run.id = (SELECT MAX(last.id) FROM automation_runs AS last
        WHERE last.task_id = task.task_id AND last.ended_at IS NOT NULL)
      WHERE task.purpose = 'user_automation' AND task.builtin = 0 AND task.enabled = 0
        AND task.running_since IS NULL AND run.status = 'completed'
        AND ((json_extract(run.followup_json, '$.action') = 'stop'
            AND json_extract(run.followup_json, '$.generation') = task.followup_generation)
          OR (task.next_run_at IS NULL AND json_extract(run.trigger_json, '$.source') = 'scheduled'
            AND json_array_length(task.triggers) > 0
            AND NOT EXISTS (SELECT 1 FROM json_each(task.triggers) AS trigger
              WHERE json_extract(trigger.value, '$.type') IS NOT 'time'
                OR json_extract(trigger.value, '$.at') IS NULL
                OR json_extract(trigger.value, '$.every') IS NOT NULL
                OR json_extract(trigger.value, '$.days') IS NOT NULL
                OR json_extract(trigger.value, '$.on') >= date('now', '-1 day'))))`
    )
    .all()
  for (const row of finished) {
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

export const finishedAutomations: Migration = {
  version: 101,
  name: "finished_automations",
  foreignKeys: { kind: "enforced" },
  up
}
