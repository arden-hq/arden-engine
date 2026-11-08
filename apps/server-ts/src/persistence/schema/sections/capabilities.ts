import type { OperationalSchemaSection } from "../section.js"

export const capabilitiesSchemaSection = {
  name: "capabilities",
  storageDomain: "configuration",
  tables: ["mcp_servers", "permission_rules", "permission_settings", "capability_offers"],
  indexes: ["idx_permission_rules_identity", "idx_capability_offers_open"],
  triggers: ["space_archive_drops_rules"],
  statements: [
    `CREATE TABLE mcp_servers (
      name TEXT PRIMARY KEY,
      preset_id TEXT CHECK(preset_id IN (
        'github',
        'linear',
        'notion',
        'slack',
        'vercel'
      )),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
      transport_json TEXT NOT NULL
        CHECK(json_valid(transport_json) AND json_type(transport_json) = 'object'),
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE permission_rules (
      rule_id TEXT PRIMARY KEY CHECK(length(rule_id) > 0),
      list_kind TEXT NOT NULL CHECK(list_kind IN ('global', 'space', 'system')),
      space_id TEXT REFERENCES spaces(space_id) ON DELETE CASCADE,
      subject_kind TEXT NOT NULL
        CHECK(subject_kind IN ('tool', 'connector', 'command', 'host_commands', 'words', 'path')),
      tool_name TEXT CHECK(tool_name IS NULL OR length(tool_name) BETWEEN 1 AND 256),
      server_name TEXT REFERENCES mcp_servers(name) ON DELETE CASCADE,
      executable_path TEXT CHECK(executable_path IS NULL OR length(executable_path) > 0),
      argument_prefix_json TEXT CHECK(argument_prefix_json IS NULL OR
        (json_valid(argument_prefix_json) AND json_type(argument_prefix_json) = 'array')),
      words TEXT CHECK(words IS NULL OR length(words) BETWEEN 1 AND 2000),
      origin TEXT CHECK(origin IS NULL OR length(origin) BETWEEN 1 AND 512),
      path TEXT CHECK(path IS NULL OR (length(path) BETWEEN 1 AND 1000 AND substr(path, 1, 1) = '/')),
      access TEXT CHECK(access IS NULL OR access IN ('read', 'change')),
      decision TEXT NOT NULL CHECK(decision IN ('allow', 'ask', 'never')),
      source_kind TEXT NOT NULL CHECK(source_kind IN ('card', 'offer', 'settings', 'migrated')),
      source_run_id TEXT,
      source_tool_call_id TEXT,
      source_question_id TEXT REFERENCES permission_offers(question_id) ON DELETE SET NULL,
      created_at TEXT,
      CHECK((list_kind = 'space') = (space_id IS NOT NULL)),
      CHECK((subject_kind = 'tool') = (tool_name IS NOT NULL)),
      CHECK(subject_kind != 'connector' OR server_name IS NOT NULL),
      CHECK(subject_kind IN ('tool', 'connector') OR server_name IS NULL),
      CHECK((subject_kind = 'command') = (executable_path IS NOT NULL)),
      CHECK((subject_kind = 'command') = (argument_prefix_json IS NOT NULL)),
      CHECK((subject_kind = 'words') = (words IS NOT NULL)),
      CHECK((subject_kind = 'path') = (path IS NOT NULL)),
      CHECK((subject_kind = 'path') = (access IS NOT NULL)),
      CHECK(subject_kind != 'path' OR decision != 'ask'),
      CHECK(origin IS NULL OR subject_kind = 'tool'),
      CHECK(subject_kind != 'host_commands' OR decision = 'ask'),
      CHECK((source_run_id IS NULL) = (source_tool_call_id IS NULL)),
      CHECK(source_kind = 'card' OR source_run_id IS NULL),
      CHECK(source_kind = 'offer' OR source_question_id IS NULL)
    )`,
    "ALTER TABLE permission_rules ADD COLUMN from_rule_id TEXT REFERENCES permission_rules(rule_id) ON DELETE CASCADE",
    `CREATE UNIQUE INDEX idx_permission_rules_identity ON permission_rules(
      list_kind, COALESCE(space_id, ''), subject_kind, COALESCE(tool_name, ''),
      COALESCE(server_name, ''), COALESCE(executable_path, ''),
      COALESCE(argument_prefix_json, ''), COALESCE(words, ''), COALESCE(origin, ''),
      COALESCE(path, ''), COALESCE(access, ''))`,
    `CREATE TRIGGER space_archive_drops_rules AFTER UPDATE OF archived_at ON spaces
      WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL BEGIN
      DELETE FROM permission_rules WHERE list_kind = 'space' AND space_id = NEW.space_id;
    END`,
    `CREATE TABLE permission_settings (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
      default_mode TEXT NOT NULL DEFAULT 'safe'
        CHECK(default_mode IN ('read_only', 'ask', 'safe', 'allow'))
    )`,
    "INSERT INTO permission_settings (singleton_id) VALUES (1)",
    `CREATE TABLE capability_offers (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      tool_call_id TEXT NOT NULL CHECK(length(tool_call_id) > 0),
      run_id TEXT NOT NULL CHECK(length(run_id) > 0),
      candidates_json TEXT NOT NULL
        CHECK(json_valid(candidates_json) AND json_type(candidates_json) = 'array'),
      offered_at TEXT NOT NULL,
      outcome TEXT CHECK(outcome IS NULL OR outcome IN ('connected', 'declined', 'expired')),
      outcome_at TEXT,
      PRIMARY KEY (session_id, tool_call_id),
      CHECK((outcome IS NULL) = (outcome_at IS NULL))
    )`,
    "CREATE INDEX idx_capability_offers_open ON capability_offers(offered_at) WHERE outcome IS NULL"
  ]
} as const satisfies OperationalSchemaSection
