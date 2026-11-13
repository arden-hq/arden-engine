import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/** Indexes for questions asked by status or by time.
 *
 * `idx_chat_runs_active` lists unfinished runs, but SQLite uses a partial
 * index only when the query repeats its condition word for word, and most
 * queries ask `status = 'pending'` or `status IN ('running')`. A plain index
 * on status serves every form. The other two serve "what happened in this
 * time window" for run results, run starts and Task events, which read every
 * row; and "runs with no outcome yet". `row_counts` keeps the number of runs. */
const up = (database: DatabaseSync): void => {
  database.exec(`CREATE INDEX idx_chat_runs_status ON chat_runs(status, updated_at)`)
  database.exec(
    `CREATE INDEX idx_chat_runs_result_at ON chat_runs(COALESCE(json_extract(metadata_json, '$.late_result_at'), ended_at))`
  )
  database.exec(
    `CREATE INDEX idx_space_task_events_created ON space_task_events(created_at DESC, event_id DESC)`
  )
  database.exec(`CREATE INDEX idx_chat_runs_started ON chat_runs(started_at)`)
  database.exec(
    `CREATE INDEX idx_automation_runs_no_outcome ON automation_runs(id) WHERE outcome IS NULL`
  )
  database.exec(`CREATE INDEX idx_automation_runs_started ON automation_runs(started_at)`)
  database.exec(
    `CREATE INDEX idx_automation_runs_occurrence ON automation_runs(json_extract(origin, '$.occurrence_id')) WHERE task_id IS NOT NULL`
  )
  // How many runs exist, as a number: the run list shows it, and counting
  // every run each time grows with the table.
  database.exec(`CREATE TABLE row_counts (
      name TEXT PRIMARY KEY CHECK(length(name) > 0),
      rows INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID`)
  database.exec(`INSERT INTO row_counts(name, rows) SELECT 'chat_runs', COUNT(*) FROM chat_runs`)
  database.exec(`CREATE TRIGGER row_counts_chat_runs_ai
      AFTER INSERT ON chat_runs BEGIN
        UPDATE row_counts SET rows = rows + 1 WHERE name = 'chat_runs';
      END`)
  database.exec(`CREATE TRIGGER row_counts_chat_runs_ad
      AFTER DELETE ON chat_runs BEGIN
        UPDATE row_counts SET rows = rows - 1 WHERE name = 'chat_runs';
      END`)
}

export const statusAndTimeIndexes: Migration = {
  version: 147,
  name: "status_and_time_indexes",
  foreignKeys: { kind: "enforced" },
  up
}
