import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec("ALTER TABLE scheduled_tasks RENAME COLUMN running_since TO job_held_since")
  database.exec(`CREATE TRIGGER automation_job_closes_run_ad
      AFTER DELETE ON automation_event_queue
      WHEN json_extract(OLD.context, '$.automation_run_id') IS NOT NULL
      ${CLOSES_RUN}`)
  database.exec(`CREATE TRIGGER automation_job_closes_run_au
      AFTER UPDATE OF context ON automation_event_queue
      WHEN json_extract(OLD.context, '$.automation_run_id') IS NOT NULL
        AND json_extract(NEW.context, '$.automation_run_id')
          IS NOT json_extract(OLD.context, '$.automation_run_id')
      ${CLOSES_RUN}`)
  database.exec(`UPDATE automation_runs
      SET status = 'interrupted', outcome = 'interrupted',
        ended_at = MAX(started_at, COALESCE((SELECT chat.updated_at FROM chat_runs AS chat
          WHERE chat.run_id = automation_runs.chat_run_id), started_at)),
        error = 'Its job ended before the run did'
      WHERE status = 'running' AND task_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM automation_event_queue AS queue
          WHERE json_extract(queue.context, '$.automation_run_id') = automation_runs.id)`)
}

const CLOSES_RUN = `BEGIN
        UPDATE automation_runs
        SET status = 'interrupted', outcome = 'interrupted',
          ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          error = 'Its job ended before the run did'
        WHERE id = json_extract(OLD.context, '$.automation_run_id')
          AND task_id IS NOT NULL AND status = 'running';
        UPDATE scheduled_tasks SET job_held_since = NULL
        WHERE task_id = OLD.task_id AND job_held_since IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM automation_event_queue AS queue
            WHERE queue.task_id = OLD.task_id AND queue.claimed_at IS NOT NULL);
      END`

export const jobRunClosesWithJob: Migration = {
  version: 154,
  name: "job_run_closes_with_job",
  foreignKeys: { kind: "enforced" },
  up
}
