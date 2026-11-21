import type { Migration } from "./index.js"

export const eventsResume: Migration = {
  version: 184,
  name: "events_resume",
  foreignKeys: { kind: "enforced" },
  up: (database) =>
    database.exec(`UPDATE automation_deliveries
      SET payload = json_set(payload, '$.resumedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      WHERE task_id = 'builtin-urgent-events'
        AND json_extract(payload, '$.kind') = 'automation_paused'
        AND json_extract(payload, '$.resumedAt') IS NULL
        AND EXISTS (SELECT 1 FROM scheduled_tasks
          WHERE task_id = 'builtin-urgent-events' AND auto_resume_at IS NOT NULL);
      UPDATE scheduled_tasks SET enabled = 1, paused_at = NULL, auto_resume_at = NULL,
        auto_resumes = 0, failed_runs = 0, failed_item = NULL
      WHERE task_id = 'builtin-urgent-events' AND auto_resume_at IS NOT NULL;`)
}
