import type { Migration } from "./index.js"

export const goalQuestion: Migration = {
  version: 24,
  name: "goal_question",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(
      "ALTER TABLE session_focus ADD COLUMN blocked_question_id TEXT REFERENCES run_questions(question_id) ON DELETE SET NULL"
    )
  }
}
