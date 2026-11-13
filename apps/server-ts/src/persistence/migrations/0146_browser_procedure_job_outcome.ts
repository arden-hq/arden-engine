import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/** What a browser-procedure review decided. A job only said "completed",
 * whether it saved a procedure or skipped the run, and the reason for a skip
 * was written nowhere: 57 reviews had produced 2 procedures and nothing said
 * why the other 55 produced none. */
const up = (database: DatabaseSync): void => {
  database.exec(
    "ALTER TABLE browser_procedure_jobs ADD COLUMN outcome TEXT CHECK(outcome IS NULL OR outcome IN ('saved', 'skipped'))"
  )
  database.exec(
    "ALTER TABLE browser_procedure_jobs ADD COLUMN outcome_reason TEXT CHECK(outcome_reason IS NULL OR length(outcome_reason) BETWEEN 1 AND 2000)"
  )
}

export const browserProcedureJobOutcome: Migration = {
  version: 146,
  name: "browser_procedure_job_outcome",
  foreignKeys: { kind: "enforced" },
  up
}
