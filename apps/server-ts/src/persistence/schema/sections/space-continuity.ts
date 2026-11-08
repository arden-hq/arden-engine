import type { OperationalSchemaSection } from "../section.js"

export const spaceContinuitySchemaSection = {
  name: "space-continuity",
  storageDomain: "work",
  tables: ["space_conversations", "chat_summaries", "space_summaries"],
  indexes: [],
  triggers: ["space_conversation_binding", "space_conversation_session_guard"],
  statements: [
    `CREATE TABLE space_conversations (
      space_id TEXT PRIMARY KEY REFERENCES spaces(space_id) ON DELETE CASCADE,
      session_id TEXT NOT NULL UNIQUE REFERENCES sessions(session_id) ON DELETE RESTRICT
    )`,
    `CREATE TRIGGER space_conversation_binding BEFORE INSERT ON space_conversations
      WHEN NOT EXISTS (
        SELECT 1 FROM sessions WHERE session_id = NEW.session_id
          AND space_id = NEW.space_id AND session_type = 'chat'
          AND parent_session_id IS NULL AND parent_message_id IS NULL
          AND archived_at IS NULL
      ) BEGIN SELECT RAISE(ABORT, 'Space conversation must be an active ordinary chat in its Space'); END`,
    `CREATE TRIGGER space_conversation_session_guard
      BEFORE UPDATE OF space_id, session_type, parent_session_id, parent_message_id, archived_at ON sessions
      WHEN EXISTS (SELECT 1 FROM space_conversations WHERE session_id = OLD.session_id
        AND (NEW.space_id IS NOT space_id OR NEW.session_type != 'chat'
          OR NEW.parent_session_id IS NOT NULL OR NEW.parent_message_id IS NOT NULL
          OR (NEW.archived_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM spaces
            WHERE spaces.space_id = space_conversations.space_id AND spaces.archived_at IS NOT NULL))))
      BEGIN SELECT RAISE(ABORT, 'Space conversation cannot be moved or archived separately'); END`,
    `CREATE TABLE chat_summaries (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
      title TEXT NOT NULL CHECK(length(title) > 0),
      summary TEXT NOT NULL CHECK(length(summary) > 0),
      topics_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(topics_json) AND json_type(topics_json) = 'array'),
      through_sequence INTEGER NOT NULL CHECK(through_sequence >= 0),
      run_id TEXT,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE space_summaries (
      space_id TEXT PRIMARY KEY REFERENCES spaces(space_id) ON DELETE CASCADE,
      now TEXT NOT NULL CHECK(length(now) > 0),
      next_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(next_json) AND json_type(next_json) = 'array'),
      recent TEXT,
      sources_fingerprint TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  ]
} as const satisfies OperationalSchemaSection
