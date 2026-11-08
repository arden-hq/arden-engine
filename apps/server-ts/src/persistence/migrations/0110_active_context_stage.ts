import type { Migration } from "./index.js"

export const activeContextStage: Migration = {
  version: 110,
  name: "active_context_stage",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(
      "ALTER TABLE sessions ADD COLUMN legacy_context_revision INTEGER NOT NULL DEFAULT 0"
    )
    database.exec(`CREATE TRIGGER sessions_legacy_context_revision
      AFTER UPDATE OF messages ON sessions
      WHEN OLD.context_from_seq IS NULL AND NEW.context_from_seq IS NULL
        AND OLD.messages IS NOT NEW.messages
      BEGIN
        UPDATE sessions SET legacy_context_revision = legacy_context_revision + 1
        WHERE session_id = NEW.session_id;
      END`)
    database.exec(`CREATE TABLE session_context_stage (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
      source_revision INTEGER NOT NULL,
      context_generation INTEGER NOT NULL,
      source_count INTEGER NOT NULL,
      from_seq INTEGER NOT NULL,
      head_seq INTEGER,
      active_count INTEGER NOT NULL,
      newest_seq INTEGER NOT NULL,
      last_seq INTEGER NOT NULL DEFAULT -1
    )`)
  }
}
