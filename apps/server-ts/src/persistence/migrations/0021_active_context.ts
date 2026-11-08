import type { Migration } from "./index.js"

export const activeContext: Migration = {
  version: 21,
  name: "active_context",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec("ALTER TABLE sessions ADD COLUMN context_from_seq INTEGER")
    database.exec("ALTER TABLE sessions ADD COLUMN context_head_seq INTEGER")
    database.exec(`CREATE TABLE session_context_hidden (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      PRIMARY KEY (session_id, seq)
    ) WITHOUT ROWID`)
    database.exec(`CREATE INDEX idx_sessions_context_unconverted
      ON sessions(session_id) WHERE context_from_seq IS NULL`)
  }
}
