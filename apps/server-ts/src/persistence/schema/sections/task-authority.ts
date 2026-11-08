import type { OperationalSchemaSection } from "../section.js"

export const taskAuthoritySchemaSection = {
  name: "task-authority",
  storageDomain: "work",
  tables: ["focus_choices", "permission_offers"],
  indexes: ["idx_focus_choices_space_status", "idx_permission_offers_session_tool"],
  triggers: [],
  statements: [
    `CREATE TABLE focus_choices (
      choice_id TEXT PRIMARY KEY CHECK(length(choice_id) > 0),
      question_id TEXT NOT NULL UNIQUE REFERENCES run_questions(question_id) ON DELETE RESTRICT,
      source_session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE RESTRICT,
      space_id TEXT NOT NULL REFERENCES spaces(space_id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK(revision >= 0),
      target_json TEXT NOT NULL CHECK(json_valid(target_json)),
      capture_policy_json TEXT NOT NULL CHECK(json_valid(capture_policy_json)),
      status TEXT NOT NULL CHECK(status IN ('offered', 'settled')),
      decision TEXT CHECK(decision IN ('continue_here', 'open_target') OR decision IS NULL),
      result_session_id TEXT REFERENCES sessions(session_id) ON DELETE RESTRICT,
      settlement_client_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      settled_at TEXT,
      CHECK(updated_at >= created_at),
      CHECK((status = 'offered') = (decision IS NULL AND result_session_id IS NULL AND settlement_client_id IS NULL AND settled_at IS NULL)),
      CHECK(status != 'settled' OR (decision IS NOT NULL AND result_session_id IS NOT NULL AND settlement_client_id IS NOT NULL AND settled_at IS NOT NULL))
    )`,
    `CREATE INDEX idx_focus_choices_space_status
      ON focus_choices(space_id, status, updated_at DESC, choice_id)`,
    "ALTER TABLE focus_choices ADD COLUMN target_session_id TEXT REFERENCES sessions(session_id) ON DELETE RESTRICT",
    "ALTER TABLE focus_choices ADD COLUMN transition TEXT CHECK(transition IN ('moved', 'kept', 'typed_here', 'brought_back') OR transition IS NULL)",
    "ALTER TABLE focus_choices ADD COLUMN transitioned_at TEXT",
    `CREATE TABLE permission_offers (
      question_id TEXT PRIMARY KEY CHECK(length(question_id) > 0),
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      tool_name TEXT CHECK(tool_name IS NULL OR length(tool_name) BETWEEN 1 AND 256),
      server_name TEXT CHECK(server_name IS NULL OR length(server_name) > 0),
      change_json TEXT NOT NULL CHECK(json_valid(change_json)
        AND json_extract(change_json, '$.kind') IN ('tool', 'site', 'connector', 'mode', 'command', 'words', 'rule', 'path')),
      source_kind TEXT NOT NULL CHECK(source_kind IN ('message', 'approvals')),
      source_message_id TEXT,
      choices_json TEXT NOT NULL CHECK(json_valid(choices_json) AND json_type(choices_json) = 'array'),
      decision TEXT CHECK(decision IS NULL OR decision IN ('chat', 'space', 'automation', 'system', 'everywhere', 'no')),
      created_at TEXT NOT NULL,
      settled_at TEXT,
      CHECK((json_extract(change_json, '$.kind') IN ('tool', 'site')) = (tool_name IS NOT NULL)),
      CHECK(json_extract(change_json, '$.kind') != 'connector' OR server_name IS NOT NULL),
      CHECK((source_kind = 'message') = (source_message_id IS NOT NULL)),
      CHECK((decision IS NULL) = (settled_at IS NULL))
    )`,
    `CREATE INDEX idx_permission_offers_session_tool
      ON permission_offers(session_id, tool_name)`
  ]
} as const satisfies OperationalSchemaSection
