import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/** Two lookups that read thousands of rows to find a few.
 *
 * The latest run of an Automation: a dozen queries ask
 * `WHERE task_id = ? ORDER BY id DESC LIMIT n`, and the only index on task_id
 * was ordered by start time, so each read and sorted every run of the
 * Automation (3,500 for the busiest). The new index is in the asked order.
 *
 * Runs that used the browser and wait for a recipe review: the check ran
 * after every run and every 30 seconds, and walked every completed run.
 * `browser_procedure_candidates` holds the runs with a browser tool call that
 * the check has not judged yet. A trigger adds a run at its first browser
 * call; the check removes it once the run has settled. The first fill lists
 * the browser runs with no review job. */
const up = (database: DatabaseSync): void => {
  database.exec(`CREATE INDEX idx_automation_runs_task_latest ON automation_runs(task_id, id DESC)`)
  database.exec(`CREATE TABLE browser_procedure_candidates (
      run_id TEXT PRIMARY KEY REFERENCES chat_runs(run_id) ON DELETE CASCADE
    ) WITHOUT ROWID`)
  database.exec(`INSERT OR IGNORE INTO browser_procedure_candidates(run_id)
      SELECT DISTINCT call.run_id FROM tool_calls AS call
      JOIN chat_runs AS run ON run.run_id = call.run_id
      WHERE call.tool_name IN ('browser_open', 'browser_snapshot', 'browser_act')
        AND NOT EXISTS (SELECT 1 FROM browser_procedure_jobs AS job WHERE job.run_id = call.run_id)`)
  database.exec(`CREATE TRIGGER browser_procedure_candidates_call_ai
      AFTER INSERT ON tool_calls WHEN new.tool_name IN ('browser_open', 'browser_snapshot', 'browser_act') BEGIN
        INSERT OR IGNORE INTO browser_procedure_candidates(run_id)
          SELECT run_id FROM chat_runs WHERE run_id = new.run_id;
      END`)
}

export const runLookupLists: Migration = {
  version: 149,
  name: "run_lookup_lists",
  foreignKeys: { kind: "enforced" },
  up
}
