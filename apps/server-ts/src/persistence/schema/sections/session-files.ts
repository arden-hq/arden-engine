import type { OperationalSchemaSection } from "../section.js"

export const sessionFilesSchemaSection = {
  name: "session-files",
  storageDomain: "payload_lifecycle",
  tables: [
    "session_file_cleanup",
    "managed_output_gc_candidates",
    "managed_output_lifecycle_lock",
    "chat_upload_cleanup",
    "chat_upload_refs",
    "chat_upload_unlisted"
  ],
  indexes: ["idx_chat_upload_refs_message"],
  triggers: [
    "chat_upload_unlisted_ai",
    "chat_upload_unlisted_au",
    "chat_upload_unlisted_ad",
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
    // Which message names which upload folder. Triggers note a message in
    // `chat_upload_unlisted`; the engine reads those and fills `chat_upload_refs`.
    `CREATE TABLE chat_upload_refs (
      upload_id TEXT NOT NULL CHECK(length(upload_id) = 36),
      message_rowid INTEGER NOT NULL,
      PRIMARY KEY (upload_id, message_rowid)
    ) WITHOUT ROWID`,
    "CREATE INDEX idx_chat_upload_refs_message ON chat_upload_refs(message_rowid)",
    `CREATE TABLE chat_upload_unlisted (
      message_rowid INTEGER PRIMARY KEY
    )`,
    `CREATE TRIGGER chat_upload_unlisted_ai
      AFTER INSERT ON session_messages
      WHEN new.role = 'user' AND instr(new.message_json, '/uploads/') > 0 BEGIN
        INSERT OR IGNORE INTO chat_upload_unlisted(message_rowid) VALUES (new.message_rowid);
      END`,
    `CREATE TRIGGER chat_upload_unlisted_au
      AFTER UPDATE OF role, message_json ON session_messages
      WHEN instr(new.message_json, '/uploads/') > 0 OR instr(old.message_json, '/uploads/') > 0
      BEGIN
        INSERT OR IGNORE INTO chat_upload_unlisted(message_rowid) VALUES (new.message_rowid);
      END`,
    `CREATE TRIGGER chat_upload_unlisted_ad
      AFTER DELETE ON session_messages BEGIN
        DELETE FROM chat_upload_unlisted WHERE message_rowid = old.message_rowid;
        DELETE FROM chat_upload_refs WHERE message_rowid = old.message_rowid;
      END`
  ]
} as const satisfies OperationalSchemaSection
