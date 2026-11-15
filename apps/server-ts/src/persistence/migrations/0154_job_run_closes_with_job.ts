import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/** A job run is open exactly while a queue row names it.
 *
 * `automation_runs.status = 'running'` was written at claim and cleared only
 * by settlement, so a queue row deleted any other way left its run running for
 * good. Such a run held every Memory change its Automation produced: Wiki
 * Maintenance waits while a producer has a running run. On the owner's data,
 * 11 runs from 9 and 10 October had no job and held 128 waiting changes.
 *
 * Two triggers now close the run in the same statement that deletes its queue
 * row, or points that row at another run. Settlement ends the run before it
 * deletes the row, so there they change nothing. The task's `job_held_since`
 * is cleared too once none of its rows is claimed, as recovery does at start.
 * Runs that belong to a chat run (`task_id IS NULL`) have no queue row and are
 * left alone. The runs already open with no job are closed the same way, but
 * at the last time each is known to have been alive (its chat run's last
 * update, else its start), not at the update: an Automation's cooldown counts
 * from its last ending and the history sorts by it.
 *
 * `scheduled_tasks.running_since` becomes `job_held_since`: it is set when a
 * worker claims one of the Automation's jobs and cleared when that job settles,
 * is released, retries or is deferred, so it never meant "the Automation is
 * running". That is the open run (automation-running.ts). */
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
