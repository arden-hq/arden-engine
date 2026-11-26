import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(`CREATE TABLE chat_upload_refs (
      upload_id TEXT NOT NULL CHECK(length(upload_id) = 36),
      message_rowid INTEGER NOT NULL,
      PRIMARY KEY (upload_id, message_rowid)
    ) WITHOUT ROWID`)
  database.exec("CREATE INDEX idx_chat_upload_refs_message ON chat_upload_refs(message_rowid)")
  database.exec(`CREATE TABLE chat_upload_unlisted (
      message_rowid INTEGER PRIMARY KEY
    )`)
  database.exec(`INSERT INTO chat_upload_unlisted (message_rowid)
    SELECT message_rowid FROM chat_upload_messages`)
  database.exec("DROP TRIGGER chat_upload_messages_ai")
  database.exec("DROP TRIGGER chat_upload_messages_au")
  database.exec("DROP TRIGGER chat_upload_messages_ad")
  database.exec("DROP TABLE chat_upload_messages")
  database.exec(`CREATE TRIGGER chat_upload_unlisted_ai
      AFTER INSERT ON session_messages
      WHEN new.role = 'user' AND instr(new.message_json, '/uploads/') > 0 BEGIN
        INSERT OR IGNORE INTO chat_upload_unlisted(message_rowid) VALUES (new.message_rowid);
      END`)
  database.exec(`CREATE TRIGGER chat_upload_unlisted_au
      AFTER UPDATE OF role, message_json ON session_messages
      WHEN instr(new.message_json, '/uploads/') > 0 OR instr(old.message_json, '/uploads/') > 0
      BEGIN
        INSERT OR IGNORE INTO chat_upload_unlisted(message_rowid) VALUES (new.message_rowid);
      END`)
  database.exec(`CREATE TRIGGER chat_upload_unlisted_ad
      AFTER DELETE ON session_messages BEGIN
        DELETE FROM chat_upload_unlisted WHERE message_rowid = old.message_rowid;
        DELETE FROM chat_upload_refs WHERE message_rowid = old.message_rowid;
      END`)
}

export const chatUploadRefs: Migration = {
  version: 143,
  name: "chat_upload_refs",
  foreignKeys: { kind: "enforced" },
  up
}
