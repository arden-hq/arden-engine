import type { Migration } from "./index.js"

export const questionTimers: Migration = {
  version: 79,
  name: "question_timers",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(`CREATE TABLE run_question_timers (
      question_id TEXT PRIMARY KEY REFERENCES run_questions(question_id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      seconds INTEGER NOT NULL CHECK(seconds > 0),
      fallback_choice_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'elapsed', 'cancelled'))
    )`)
    database.exec(
      "CREATE INDEX idx_run_question_timers_pending ON run_question_timers(expires_at) WHERE status = 'pending'"
    )
  }
}
