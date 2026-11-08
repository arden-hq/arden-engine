import type { OperationalSchemaSection } from "../section.js"

export const sessionFilesSchemaSection = {
  name: "session-files",
  storageDomain: "payload_lifecycle",
  tables: [
    "session_file_cleanup",
    "managed_output_gc_candidates",
    "managed_output_lifecycle_lock",
    "chat_upload_cleanup",
    "chat_upload_messages"
  ],
  indexes: [],
  triggers: [
    "chat_upload_messages_ai",
    "chat_upload_messages_au",
    "chat_upload_messages_ad",
    "session_file_cleanup_no_recreate"
  ],
  statements: [
    `CREATE TABLE session_file_cleanup (
      session_id TEXT PRIMARY KEY CHECK(length(session_id) > 0),
      queued_at TEXT NOT NULL
    )`,
    `CREATE TABLE managed_output_gc_candidates (
      session_id TEXT NOT NULL CHECK(length(session_id) > 0),
      sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
      PRIMARY KEY(session_id, sha256)
    )`,
    `CREATE TABLE managed_output_lifecycle_lock (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
      generation INTEGER NOT NULL CHECK(generation >= 0),
      holder_pid INTEGER CHECK(holder_pid IS NULL OR holder_pid > 0),
      holder_token TEXT CHECK(
        (holder_pid IS NULL AND holder_token IS NULL) OR
        (holder_pid IS NOT NULL AND holder_token IS NOT NULL AND length(holder_token) > 0)
      )
    )`,
    `CREATE TRIGGER session_file_cleanup_no_recreate
      BEFORE INSERT ON sessions
      WHEN EXISTS (SELECT 1 FROM session_file_cleanup WHERE session_id = new.session_id)
      BEGIN
        SELECT RAISE(ABORT, 'Session file cleanup is pending');
      END`,
    `CREATE TABLE chat_upload_cleanup (
      upload_id TEXT PRIMARY KEY CHECK(length(upload_id) = 36),
      queued_at TEXT NOT NULL,
      failures INTEGER NOT NULL DEFAULT 0 CHECK(failures >= 0),
      retry_after TEXT
    )`,
    `CREATE TABLE chat_upload_messages (
      message_rowid INTEGER PRIMARY KEY
    )`,
    `CREATE TRIGGER chat_upload_messages_ai
      AFTER INSERT ON session_messages
      WHEN new.role = 'user' AND instr(new.message_json, '/uploads/') > 0 BEGIN
        INSERT OR IGNORE INTO chat_upload_messages(message_rowid) VALUES (new.message_rowid);
      END`,
    `CREATE TRIGGER chat_upload_messages_au
      AFTER UPDATE OF role, message_json ON session_messages
      WHEN new.role = 'user' AND instr(new.message_json, '/uploads/') > 0 BEGIN
        INSERT OR IGNORE INTO chat_upload_messages(message_rowid) VALUES (new.message_rowid);
      END`,
    `CREATE TRIGGER chat_upload_messages_ad
      AFTER DELETE ON session_messages BEGIN
        DELETE FROM chat_upload_messages WHERE message_rowid = old.message_rowid;
      END`
  ]
} as const satisfies OperationalSchemaSection
