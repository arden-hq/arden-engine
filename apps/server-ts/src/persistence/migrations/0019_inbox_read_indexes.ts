import type { Migration } from "./index.js"

export const inboxReadIndexes: Migration = {
  version: 19,
  name: "inbox_read_indexes",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(`CREATE INDEX idx_journal_question_changes
      ON journal_records(stream_id, event_type, sequence)
      WHERE event_type = 'question_changed'`)
    database.exec(`CREATE INDEX idx_automation_runs_status_task
      ON automation_runs(status, task_id, started_at)`)
  }
}
