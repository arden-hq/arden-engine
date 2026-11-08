import type { Migration } from "./index.js"

export const chatModelEvents: Migration = {
  version: 12,
  name: "chat_model_events",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(`CREATE TABLE chat_event_cursors (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
      checked_at TEXT NOT NULL
    )`)
    database.exec(`CREATE TABLE chat_event_deliveries (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      event_key TEXT NOT NULL CHECK(length(event_key) > 0),
      message_id TEXT NOT NULL,
      delivered_at TEXT NOT NULL,
      PRIMARY KEY (session_id, event_key)
    ) WITHOUT ROWID`)
  }
}
