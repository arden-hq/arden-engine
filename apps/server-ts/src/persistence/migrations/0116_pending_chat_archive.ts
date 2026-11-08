import type { Migration } from "./index.js"

export const pendingChatArchive: Migration = {
  version: 116,
  name: "pending_chat_archive",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(`CREATE TABLE session_pending_archives (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      requested_at TEXT NOT NULL
    )`)
    database.exec(`CREATE TRIGGER sessions_archive_drops_pending
      AFTER UPDATE OF archived_at ON sessions
      WHEN NEW.archived_at IS NOT NULL
      BEGIN
        DELETE FROM session_pending_archives WHERE session_id = NEW.session_id;
      END`)
  }
}
