import type { Migration } from "./index.js"

export const chatUploadCleanup: Migration = {
  version: 27,
  name: "chat_upload_cleanup",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(`CREATE TABLE chat_upload_cleanup (
      upload_id TEXT PRIMARY KEY CHECK(length(upload_id) = 36),
      queued_at TEXT NOT NULL,
      failures INTEGER NOT NULL DEFAULT 0 CHECK(failures >= 0),
      retry_after TEXT
    )`)
    database.exec(`CREATE TABLE chat_upload_messages (
      message_rowid INTEGER PRIMARY KEY
    )`)
    database.exec(`CREATE TRIGGER chat_upload_messages_ai
      AFTER INSERT ON session_messages
      WHEN new.role = 'user' AND instr(new.message_json, '/uploads/') > 0 BEGIN
        INSERT OR IGNORE INTO chat_upload_messages(message_rowid) VALUES (new.message_rowid);
      END`)
    database.exec(`CREATE TRIGGER chat_upload_messages_au
      AFTER UPDATE OF role, message_json ON session_messages
      WHEN new.role = 'user' AND instr(new.message_json, '/uploads/') > 0 BEGIN
        INSERT OR IGNORE INTO chat_upload_messages(message_rowid) VALUES (new.message_rowid);
      END`)
    database.exec(`CREATE TRIGGER chat_upload_messages_ad
      AFTER DELETE ON session_messages BEGIN
        DELETE FROM chat_upload_messages WHERE message_rowid = old.message_rowid;
      END`)
  }
}
