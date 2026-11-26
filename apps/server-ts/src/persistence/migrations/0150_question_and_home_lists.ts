import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(`CREATE INDEX idx_journal_question_latest
      ON journal_records(stream_id, json_extract(data_json, '$.question_id'), sequence)
      WHERE event_type = 'question_changed'`)
  database.exec(
    `CREATE INDEX idx_run_questions_created ON run_questions(created_at DESC, question_id DESC)`
  )
  database.exec(`CREATE INDEX idx_run_questions_unsettled ON run_questions(created_at DESC, question_id DESC)
      WHERE resolution IS NULL AND closed_at IS NULL`)
  database.exec(`CREATE INDEX idx_space_task_comments_created ON space_task_comments(created_at)`)
  database.exec(`CREATE INDEX idx_chat_runs_worker_result
      ON chat_runs(COALESCE(json_extract(metadata_json, '$.late_result_at'), ended_at))
      WHERE json_extract(metadata_json, '$.run_policy.execution.mode') = 'worker'`)
}

export const questionAndHomeLists: Migration = {
  version: 150,
  name: "question_and_home_lists",
  foreignKeys: { kind: "enforced" },
  up
}
