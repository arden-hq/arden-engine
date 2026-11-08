import type { OperationalSchemaSection } from "../section.js"

export const contextSessionSchemaSection = {
  name: "context.session",
  storageDomain: "conversation",
  tables: [
    "sessions",
    "session_fork_requests",
    "session_messages",
    "session_turns",
    "session_context_hidden",
    "session_context_stage",
    "chat_event_cursors",
    "chat_event_deliveries",
    "answer_block_state",
    "message_turns",
    "session_pending_archives"
  ],
  indexes: [
    "idx_sessions_activity",
    "idx_sessions_archived",
    "idx_session_messages_client",
    "idx_session_turns_session_turn",
    "idx_sessions_space_activity",
    "idx_sessions_parent_activity",
    "idx_sessions_agent_origin",
    "idx_sessions_list",
    "idx_sessions_context_unconverted",
    "idx_sessions_fork_origin_backfill",
    "idx_session_fork_requests_preparing_source",
    "idx_message_turns_turn"
  ],
  triggers: [
    "session_messages_role_insert",
    "session_messages_role_update",
    "message_turns_ai",
    "message_turns_au",
    "message_turns_ad",
    "sessions_legacy_context_revision",
    "sessions_archive_drops_pending"
  ],
  statements: [
    `CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      public_ref TEXT NOT NULL UNIQUE,
      started_at TEXT NOT NULL,
      last_activity TEXT NOT NULL,
      last_accessed_at TEXT,
      name TEXT,
      archived_at TEXT,
      session_type TEXT NOT NULL DEFAULT 'chat' CHECK(session_type IN ('chat', 'channel', 'agent')),
      origin_automation_id TEXT,
      parent_session_id TEXT,
      parent_run_id TEXT,
      parent_tool_call_id TEXT,
      space_id TEXT REFERENCES spaces(space_id) ON DELETE SET NULL,
      chat_model TEXT,
      context_generation INTEGER NOT NULL DEFAULT 0,
      active_message_count INTEGER NOT NULL DEFAULT 0,
      parent_message_id TEXT,
      has_unread INTEGER NOT NULL DEFAULT 0 CHECK(has_unread IN (0, 1)),
      visible_message_count INTEGER NOT NULL DEFAULT 0,
      metadata TEXT,
      messages TEXT, context_from_seq INTEGER, context_head_seq INTEGER, legacy_context_revision INTEGER NOT NULL DEFAULT 0,
      CHECK(
        (session_type = 'agent'
          AND parent_session_id IS NOT NULL
          AND parent_run_id IS NOT NULL
          AND parent_tool_call_id IS NOT NULL
          AND parent_message_id IS NULL)
        OR
        (session_type <> 'agent'
          AND parent_run_id IS NULL
          AND parent_tool_call_id IS NULL)
      )
    )`,
    `CREATE TABLE session_pending_archives (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      requested_at TEXT NOT NULL
    )`,
    `CREATE TRIGGER sessions_archive_drops_pending
      AFTER UPDATE OF archived_at ON sessions
      WHEN NEW.archived_at IS NOT NULL
      BEGIN
        DELETE FROM session_pending_archives WHERE session_id = NEW.session_id;
      END`,
    `CREATE TABLE session_fork_requests (
      request_id TEXT PRIMARY KEY,
      source_session_id TEXT NOT NULL,
      request_json TEXT NOT NULL,
      child_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(session_id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK(state IN ('preparing', 'ready'))
    )`,
    "CREATE INDEX idx_session_fork_requests_preparing_source ON session_fork_requests(source_session_id) WHERE state = 'preparing'",
    `CREATE INDEX idx_sessions_fork_origin_backfill ON sessions(session_id)
      WHERE CASE WHEN json_valid(metadata) THEN json_type(metadata, '$.fork_of') = 'object'
        AND json_type(metadata, '$.fork_of.source_session_id') = 'text'
        AND length(json_extract(metadata, '$.fork_of.source_session_id')) > 0
        AND json_type(metadata, '$.fork_of.through_sequence') = 'integer'
        AND CAST(json_extract(metadata, '$.fork_of.through_sequence') AS INTEGER) >= -1
        ELSE 0 END`,
    "CREATE INDEX idx_sessions_activity ON sessions(last_activity)",
    "CREATE INDEX idx_sessions_archived ON sessions(archived_at)",
    `CREATE TABLE session_messages (
      message_rowid INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      message_json TEXT NOT NULL,
      client_id TEXT,
      created_at TEXT NOT NULL,
      search_text TEXT,
      UNIQUE (session_id, message_id),
      UNIQUE (session_id, seq)
    )`,
    "CREATE INDEX idx_session_messages_client ON session_messages(session_id, client_id)",
    `CREATE TABLE session_context_hidden (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      PRIMARY KEY (session_id, seq)
    ) WITHOUT ROWID`,
    `CREATE TABLE session_context_stage (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
      source_revision INTEGER NOT NULL,
      context_generation INTEGER NOT NULL,
      source_count INTEGER NOT NULL,
      from_seq INTEGER NOT NULL,
      head_seq INTEGER,
      active_count INTEGER NOT NULL,
      newest_seq INTEGER NOT NULL,
      last_seq INTEGER NOT NULL DEFAULT -1
    )`,
    `CREATE TRIGGER sessions_legacy_context_revision
      AFTER UPDATE OF messages ON sessions
      WHEN OLD.context_from_seq IS NULL AND NEW.context_from_seq IS NULL
        AND OLD.messages IS NOT NEW.messages
      BEGIN
        UPDATE sessions SET legacy_context_revision = legacy_context_revision + 1
        WHERE session_id = NEW.session_id;
      END`,
    `CREATE TRIGGER session_messages_role_insert
      BEFORE INSERT ON session_messages
      WHEN NEW.role NOT IN ('system', 'developer', 'user', 'assistant', 'tool')
      BEGIN
        SELECT RAISE(ABORT, 'Unknown transcript message role');
      END`,
    `CREATE TRIGGER session_messages_role_update
      BEFORE UPDATE OF role ON session_messages
      WHEN NEW.role NOT IN ('system', 'developer', 'user', 'assistant', 'tool')
      BEGIN
        SELECT RAISE(ABORT, 'Unknown transcript message role');
      END`,
    `CREATE TABLE session_turns (
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      user_message_id TEXT NOT NULL,
      message_start_id TEXT NOT NULL,
      message_end_id TEXT NOT NULL,
      message_start_seq INTEGER NOT NULL,
      message_end_seq INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      PRIMARY KEY (session_id, turn_id),
      UNIQUE (session_id, turn_index)
    )`,
    "CREATE INDEX idx_session_turns_session_turn ON session_turns(session_id, turn_index)",
    `CREATE TABLE chat_event_cursors (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
      checked_at TEXT NOT NULL
    )`,
    `CREATE TABLE chat_event_deliveries (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      event_key TEXT NOT NULL CHECK(length(event_key) > 0),
      message_id TEXT NOT NULL,
      delivered_at TEXT NOT NULL,
      PRIMARY KEY (session_id, event_key)
    ) WITHOUT ROWID`,
    `CREATE TABLE answer_block_state (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      message_id TEXT NOT NULL CHECK(length(message_id) > 0),
      block_index INTEGER NOT NULL CHECK(block_index >= 0),
      state_json TEXT NOT NULL CHECK(
        json_valid(state_json) AND json_type(state_json) = 'object' AND length(CAST(state_json AS BLOB)) <= 8192
      ),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, message_id, block_index)
    ) WITHOUT ROWID`,
    "CREATE INDEX idx_sessions_space_activity ON sessions(space_id, last_activity DESC)",
    "CREATE INDEX idx_sessions_parent_activity ON sessions(parent_session_id, started_at)",
    `CREATE UNIQUE INDEX idx_sessions_agent_origin
      ON sessions(parent_run_id, parent_tool_call_id)
      WHERE session_type = 'agent'`,
    `CREATE INDEX idx_sessions_list
      ON sessions(archived_at, session_type, last_activity DESC, session_id DESC)`,
    `CREATE INDEX idx_sessions_context_unconverted
      ON sessions(session_id) WHERE context_from_seq IS NULL`,
    `CREATE TABLE message_turns (
      message_rowid INTEGER PRIMARY KEY,
      turn_id TEXT
    )`,
    "CREATE INDEX idx_message_turns_turn ON message_turns(turn_id) WHERE turn_id IS NOT NULL",
    `CREATE TRIGGER message_turns_ai
      AFTER INSERT ON session_messages BEGIN
        INSERT OR REPLACE INTO message_turns(message_rowid, turn_id) VALUES (
          new.message_rowid,
          CASE WHEN json_valid(new.message_json) THEN json_extract(new.message_json, '$.turn_id') END
        );
      END`,
    `CREATE TRIGGER message_turns_au
      AFTER UPDATE OF message_json ON session_messages BEGIN
        INSERT OR REPLACE INTO message_turns(message_rowid, turn_id) VALUES (
          new.message_rowid,
          CASE WHEN json_valid(new.message_json) THEN json_extract(new.message_json, '$.turn_id') END
        );
      END`,
    `CREATE TRIGGER message_turns_ad
      AFTER DELETE ON session_messages BEGIN
        DELETE FROM message_turns WHERE message_rowid = old.message_rowid;
      END`
  ]
} as const satisfies OperationalSchemaSection
