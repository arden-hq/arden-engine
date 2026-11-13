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
    "chat_upload_unlisted",
    "session_sizes",
    "session_type_sizes"
  ],
  indexes: ["idx_chat_upload_refs_message"],
  triggers: [
    "chat_upload_unlisted_ai",
    "chat_upload_unlisted_au",
    "chat_upload_unlisted_ad",
    "session_file_cleanup_no_recreate",
    "session_sizes_message_ai",
    "session_sizes_message_ad",
    "session_sizes_message_au",
    "session_sizes_run_ai",
    "session_sizes_run_ad",
    "session_sizes_run_au",
    "session_sizes_session_ai",
    "session_sizes_session_ad",
    "session_sizes_session_au"
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
      END`,
    // Chat sizes as numbers, kept by triggers (migration 145).
    `CREATE TABLE session_sizes (
      session_id TEXT PRIMARY KEY,
      message_json_bytes INTEGER NOT NULL DEFAULT 0,
      search_text_bytes INTEGER NOT NULL DEFAULT 0,
      run_bytes INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID`,
    `CREATE TABLE session_type_sizes (
      session_type TEXT PRIMARY KEY,
      message_json_bytes INTEGER NOT NULL DEFAULT 0,
      search_text_bytes INTEGER NOT NULL DEFAULT 0,
      run_bytes INTEGER NOT NULL DEFAULT 0,
      own_bytes INTEGER NOT NULL DEFAULT 0,
      sessions INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID`,
    `CREATE TRIGGER session_sizes_message_ai
      AFTER INSERT ON session_messages BEGIN
        INSERT INTO session_sizes(session_id, message_json_bytes, search_text_bytes)
          VALUES (new.session_id, octet_length(new.message_json), COALESCE(octet_length(new.search_text), 0))
          ON CONFLICT(session_id) DO UPDATE SET
            message_json_bytes = message_json_bytes + excluded.message_json_bytes,
            search_text_bytes = search_text_bytes + excluded.search_text_bytes;
        UPDATE session_type_sizes SET
            message_json_bytes = message_json_bytes + octet_length(new.message_json),
            search_text_bytes = search_text_bytes + COALESCE(octet_length(new.search_text), 0)
          WHERE session_type = (SELECT session_type FROM sessions WHERE session_id = new.session_id);
      END`,
    `CREATE TRIGGER session_sizes_message_ad
      AFTER DELETE ON session_messages BEGIN
        UPDATE session_sizes SET
            message_json_bytes = message_json_bytes - octet_length(old.message_json),
            search_text_bytes = search_text_bytes - COALESCE(octet_length(old.search_text), 0)
          WHERE session_id = old.session_id;
        UPDATE session_type_sizes SET
            message_json_bytes = message_json_bytes - octet_length(old.message_json),
            search_text_bytes = search_text_bytes - COALESCE(octet_length(old.search_text), 0)
          WHERE session_type = (SELECT session_type FROM sessions WHERE session_id = old.session_id);
      END`,
    `CREATE TRIGGER session_sizes_message_au
      AFTER UPDATE OF session_id, message_json, search_text ON session_messages BEGIN
        UPDATE session_sizes SET
            message_json_bytes = message_json_bytes - octet_length(old.message_json),
            search_text_bytes = search_text_bytes - COALESCE(octet_length(old.search_text), 0)
          WHERE session_id = old.session_id;
        UPDATE session_type_sizes SET
            message_json_bytes = message_json_bytes - octet_length(old.message_json),
            search_text_bytes = search_text_bytes - COALESCE(octet_length(old.search_text), 0)
          WHERE session_type = (SELECT session_type FROM sessions WHERE session_id = old.session_id);
        INSERT INTO session_sizes(session_id, message_json_bytes, search_text_bytes)
          VALUES (new.session_id, octet_length(new.message_json), COALESCE(octet_length(new.search_text), 0))
          ON CONFLICT(session_id) DO UPDATE SET
            message_json_bytes = message_json_bytes + excluded.message_json_bytes,
            search_text_bytes = search_text_bytes + excluded.search_text_bytes;
        UPDATE session_type_sizes SET
            message_json_bytes = message_json_bytes + octet_length(new.message_json),
            search_text_bytes = search_text_bytes + COALESCE(octet_length(new.search_text), 0)
          WHERE session_type = (SELECT session_type FROM sessions WHERE session_id = new.session_id);
      END`,
    `CREATE TRIGGER session_sizes_run_ai
      AFTER INSERT ON chat_runs BEGIN
        INSERT INTO session_sizes(session_id, run_bytes) VALUES (new.session_id, COALESCE(octet_length(new.metadata_json), 0) + COALESCE(octet_length(new.error_message), 0))
          ON CONFLICT(session_id) DO UPDATE SET run_bytes = run_bytes + excluded.run_bytes;
        UPDATE session_type_sizes SET run_bytes = run_bytes + COALESCE(octet_length(new.metadata_json), 0) + COALESCE(octet_length(new.error_message), 0)
          WHERE session_type = (SELECT session_type FROM sessions WHERE session_id = new.session_id);
      END`,
    `CREATE TRIGGER session_sizes_run_ad
      AFTER DELETE ON chat_runs BEGIN
        UPDATE session_sizes SET run_bytes = run_bytes - (COALESCE(octet_length(old.metadata_json), 0) + COALESCE(octet_length(old.error_message), 0))
          WHERE session_id = old.session_id;
        UPDATE session_type_sizes SET run_bytes = run_bytes - (COALESCE(octet_length(old.metadata_json), 0) + COALESCE(octet_length(old.error_message), 0))
          WHERE session_type = (SELECT session_type FROM sessions WHERE session_id = old.session_id);
      END`,
    `CREATE TRIGGER session_sizes_run_au
      AFTER UPDATE OF session_id, metadata_json, error_message ON chat_runs BEGIN
        UPDATE session_sizes SET run_bytes = run_bytes - (COALESCE(octet_length(old.metadata_json), 0) + COALESCE(octet_length(old.error_message), 0))
          WHERE session_id = old.session_id;
        UPDATE session_type_sizes SET run_bytes = run_bytes - (COALESCE(octet_length(old.metadata_json), 0) + COALESCE(octet_length(old.error_message), 0))
          WHERE session_type = (SELECT session_type FROM sessions WHERE session_id = old.session_id);
        INSERT INTO session_sizes(session_id, run_bytes) VALUES (new.session_id, COALESCE(octet_length(new.metadata_json), 0) + COALESCE(octet_length(new.error_message), 0))
          ON CONFLICT(session_id) DO UPDATE SET run_bytes = run_bytes + excluded.run_bytes;
        UPDATE session_type_sizes SET run_bytes = run_bytes + COALESCE(octet_length(new.metadata_json), 0) + COALESCE(octet_length(new.error_message), 0)
          WHERE session_type = (SELECT session_type FROM sessions WHERE session_id = new.session_id);
      END`,
    `CREATE TRIGGER session_sizes_session_ai
      AFTER INSERT ON sessions BEGIN
        INSERT OR IGNORE INTO session_sizes(session_id) VALUES (new.session_id);
        INSERT INTO session_type_sizes(session_type, message_json_bytes, search_text_bytes,
            run_bytes, own_bytes, sessions, archived)
          VALUES (new.session_type, COALESCE((SELECT message_json_bytes FROM session_sizes WHERE session_id = new.session_id), 0), COALESCE((SELECT search_text_bytes FROM session_sizes WHERE session_id = new.session_id), 0),
            COALESCE((SELECT run_bytes FROM session_sizes WHERE session_id = new.session_id), 0), COALESCE(octet_length(new.messages), 0) + COALESCE(octet_length(new.metadata), 0) + COALESCE(octet_length(new.name), 0), 1, new.archived_at IS NOT NULL)
          ON CONFLICT(session_type) DO UPDATE SET
            message_json_bytes = message_json_bytes + excluded.message_json_bytes,
            search_text_bytes = search_text_bytes + excluded.search_text_bytes,
            run_bytes = run_bytes + excluded.run_bytes,
            own_bytes = own_bytes + excluded.own_bytes,
            sessions = sessions + 1,
            archived = archived + excluded.archived;
      END`,
    `CREATE TRIGGER session_sizes_session_ad
      AFTER DELETE ON sessions BEGIN
        UPDATE session_type_sizes SET
            message_json_bytes = message_json_bytes - COALESCE((SELECT message_json_bytes FROM session_sizes WHERE session_id = old.session_id), 0),
            search_text_bytes = search_text_bytes - COALESCE((SELECT search_text_bytes FROM session_sizes WHERE session_id = old.session_id), 0),
            run_bytes = run_bytes - COALESCE((SELECT run_bytes FROM session_sizes WHERE session_id = old.session_id), 0),
            own_bytes = own_bytes - (COALESCE(octet_length(old.messages), 0) + COALESCE(octet_length(old.metadata), 0) + COALESCE(octet_length(old.name), 0)),
            sessions = sessions - 1,
            archived = archived - (old.archived_at IS NOT NULL)
          WHERE session_type = old.session_type;
        DELETE FROM session_sizes WHERE session_id = old.session_id;
      END`,
    `CREATE TRIGGER session_sizes_session_au
      AFTER UPDATE OF session_type, archived_at, messages, metadata, name ON sessions BEGIN
        UPDATE session_type_sizes SET
            message_json_bytes = message_json_bytes - COALESCE((SELECT message_json_bytes FROM session_sizes WHERE session_id = old.session_id), 0),
            search_text_bytes = search_text_bytes - COALESCE((SELECT search_text_bytes FROM session_sizes WHERE session_id = old.session_id), 0),
            run_bytes = run_bytes - COALESCE((SELECT run_bytes FROM session_sizes WHERE session_id = old.session_id), 0),
            own_bytes = own_bytes - (COALESCE(octet_length(old.messages), 0) + COALESCE(octet_length(old.metadata), 0) + COALESCE(octet_length(old.name), 0)),
            sessions = sessions - 1,
            archived = archived - (old.archived_at IS NOT NULL)
          WHERE session_type = old.session_type;
        INSERT INTO session_type_sizes(session_type, message_json_bytes, search_text_bytes,
            run_bytes, own_bytes, sessions, archived)
          VALUES (new.session_type, COALESCE((SELECT message_json_bytes FROM session_sizes WHERE session_id = new.session_id), 0), COALESCE((SELECT search_text_bytes FROM session_sizes WHERE session_id = new.session_id), 0),
            COALESCE((SELECT run_bytes FROM session_sizes WHERE session_id = new.session_id), 0), COALESCE(octet_length(new.messages), 0) + COALESCE(octet_length(new.metadata), 0) + COALESCE(octet_length(new.name), 0), 1, new.archived_at IS NOT NULL)
          ON CONFLICT(session_type) DO UPDATE SET
            message_json_bytes = message_json_bytes + excluded.message_json_bytes,
            search_text_bytes = search_text_bytes + excluded.search_text_bytes,
            run_bytes = run_bytes + excluded.run_bytes,
            own_bytes = own_bytes + excluded.own_bytes,
            sessions = sessions + 1,
            archived = archived + excluded.archived;
      END`
  ]
} as const satisfies OperationalSchemaSection
