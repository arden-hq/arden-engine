import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/** `scheduled_tasks.running_since` becomes `job_held_since`.
 *
 * The column is set when a worker claims one of the Automation's jobs and
 * cleared when that job settles, is released, retries or is deferred. A run
 * stays open across a retry wait and its chat run, so the column was never
 * "the Automation is running", yet the delete check, run-now, the home letter
 * and the Space views read it as that. They now read the open run
 * (automation-running.ts), and the column carries the name of what it holds.
 * SQLite rewrites the 0154 triggers that clear it. */
const up = (database: DatabaseSync): void => {
  database.exec("ALTER TABLE scheduled_tasks RENAME COLUMN running_since TO job_held_since")
}

export const jobHoldNamedForWhatItIs: Migration = {
  version: 156,
  name: "job_hold_named_for_what_it_is",
  foreignKeys: { kind: "enforced" },
  up
}
