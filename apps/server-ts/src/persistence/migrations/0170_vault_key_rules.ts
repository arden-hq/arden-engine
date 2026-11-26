import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

export const VAULT_KEY_RULES_TABLE = `CREATE TABLE permission_rules (
      rule_id TEXT PRIMARY KEY CHECK(length(rule_id) > 0),
      list_kind TEXT NOT NULL CHECK(list_kind IN ('global', 'space', 'system')),
      space_id TEXT REFERENCES spaces(space_id) ON DELETE CASCADE,
      subject_kind TEXT NOT NULL
        CHECK(subject_kind IN ('tool', 'connector', 'command', 'host_commands', 'words', 'path', 'vault_key')),
      tool_name TEXT CHECK(tool_name IS NULL OR length(tool_name) BETWEEN 1 AND 256),
      server_name TEXT REFERENCES mcp_servers(name) ON DELETE CASCADE,
      executable_path TEXT CHECK(executable_path IS NULL OR length(executable_path) > 0),
      argument_prefix_json TEXT CHECK(argument_prefix_json IS NULL OR
        (json_valid(argument_prefix_json) AND json_type(argument_prefix_json) = 'array')),
      words TEXT CHECK(words IS NULL OR length(words) BETWEEN 1 AND 2000),
      origin TEXT CHECK(origin IS NULL OR length(origin) BETWEEN 1 AND 512),
      path TEXT CHECK(path IS NULL OR (length(path) BETWEEN 1 AND 1000 AND substr(path, 1, 1) = '/')),
      access TEXT CHECK(access IS NULL OR access IN ('read', 'change')),
      key_name TEXT CHECK(key_name IS NULL OR length(key_name) BETWEEN 1 AND 64),
      key_id TEXT CHECK(key_id IS NULL OR length(key_id) BETWEEN 1 AND 64),
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
      CHECK((subject_kind = 'vault_key') = (key_name IS NOT NULL)),
      CHECK((subject_kind = 'vault_key') = (key_id IS NOT NULL)),
      CHECK(origin IS NULL OR subject_kind = 'tool'),
      CHECK(subject_kind != 'host_commands' OR decision = 'ask'),
      CHECK((source_run_id IS NULL) = (source_tool_call_id IS NULL)),
      CHECK(source_kind = 'card' OR source_run_id IS NULL),
      CHECK(source_kind = 'offer' OR source_question_id IS NULL)
    )`

export const VAULT_KEY_RULES_FROM_RULE =
  "ALTER TABLE permission_rules ADD COLUMN from_rule_id TEXT REFERENCES permission_rules(rule_id) ON DELETE CASCADE"

export const VAULT_KEY_RULES_IDENTITY = `CREATE UNIQUE INDEX idx_permission_rules_identity ON permission_rules(
      list_kind, COALESCE(space_id, ''), subject_kind, COALESCE(tool_name, ''),
      COALESCE(server_name, ''), COALESCE(executable_path, ''),
      COALESCE(argument_prefix_json, ''), COALESCE(words, ''), COALESCE(origin, ''),
      COALESCE(path, ''), COALESCE(access, ''), COALESCE(key_id, ''))`

const RULE_HISTORY = [
  `CREATE TRIGGER permission_rule_saved AFTER INSERT ON permission_rules BEGIN
      INSERT INTO permission_changes (
        permission_kind, permission_id, action, principal, subject_kind, server_name, tool_name,
        argument_count, next_mode, source_question_id, source_session_id, source_run_id,
        source_tool_call_id, occurred_at, recorded_at
      ) VALUES (
        'rule', NEW.rule_id, 'granted',
        CASE NEW.list_kind WHEN 'space' THEN 'space:' || NEW.space_id ELSE NEW.list_kind END,
        NEW.subject_kind, NEW.server_name, NEW.tool_name,
        json_array_length(NEW.argument_prefix_json), NEW.decision, NEW.source_question_id,
        COALESCE((SELECT session_id FROM permission_offers WHERE question_id = NEW.source_question_id),
          (SELECT session_id FROM chat_runs WHERE run_id = NEW.source_run_id)),
        NEW.source_run_id, NEW.source_tool_call_id, NEW.created_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
    END`,
  `CREATE TRIGGER permission_rule_changed AFTER UPDATE OF decision ON permission_rules
      WHEN OLD.decision IS NOT NEW.decision BEGIN
      INSERT INTO permission_changes (
        permission_kind, permission_id, action, principal, subject_kind, server_name, tool_name,
        argument_count, previous_mode, next_mode, source_question_id, source_session_id,
        source_run_id, source_tool_call_id, occurred_at, recorded_at
      ) VALUES (
        'rule', NEW.rule_id, 'changed',
        CASE NEW.list_kind WHEN 'space' THEN 'space:' || NEW.space_id ELSE NEW.list_kind END,
        NEW.subject_kind, NEW.server_name, NEW.tool_name,
        json_array_length(NEW.argument_prefix_json), OLD.decision, NEW.decision,
        NEW.source_question_id,
        COALESCE((SELECT session_id FROM permission_offers WHERE question_id = NEW.source_question_id),
          (SELECT session_id FROM chat_runs WHERE run_id = NEW.source_run_id)),
        NEW.source_run_id, NEW.source_tool_call_id, NEW.created_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
    END`,
  `CREATE TRIGGER permission_rule_removed BEFORE DELETE ON permission_rules BEGIN
      INSERT INTO permission_changes (
        permission_kind, permission_id, action, principal, subject_kind, server_name, tool_name,
        argument_count, previous_mode, source_question_id, source_session_id, source_run_id,
        source_tool_call_id, occurred_at, recorded_at
      ) VALUES (
        'rule', OLD.rule_id, 'revoked',
        CASE OLD.list_kind WHEN 'space' THEN 'space:' || OLD.space_id ELSE OLD.list_kind END,
        OLD.subject_kind, OLD.server_name, OLD.tool_name,
        json_array_length(OLD.argument_prefix_json), OLD.decision, OLD.source_question_id,
        (SELECT source_session_id FROM permission_changes
          WHERE permission_kind = 'rule' AND permission_id = OLD.rule_id
          ORDER BY change_id LIMIT 1),
        OLD.source_run_id, OLD.source_tool_call_id,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
    END`
]

const up = (database: DatabaseSync): void => {
  database.exec("PRAGMA legacy_alter_table = ON")
  try {
    database.exec("ALTER TABLE permission_rules RENAME TO permission_rules_prior")
  } finally {
    database.exec("PRAGMA legacy_alter_table = OFF")
  }
  database.exec(VAULT_KEY_RULES_TABLE)
  database.exec(VAULT_KEY_RULES_FROM_RULE)
  const columns = `rule_id, list_kind, space_id, subject_kind, tool_name, server_name, executable_path,
      argument_prefix_json, words, origin, path, access, decision, source_kind, source_run_id,
      source_tool_call_id, source_question_id, created_at, from_rule_id`
  database.exec(
    `INSERT INTO permission_rules (${columns}) SELECT ${columns} FROM permission_rules_prior`
  )
  database.exec("DROP TABLE permission_rules_prior")
  database.exec(VAULT_KEY_RULES_IDENTITY)
  database.exec("CREATE INDEX idx_permission_rules_from_rule_id ON permission_rules(from_rule_id)")
  database.exec("CREATE INDEX idx_permission_rules_server_name ON permission_rules(server_name)")
  database.exec(
    "CREATE INDEX idx_permission_rules_source_question_id ON permission_rules(source_question_id)"
  )
  database.exec("CREATE INDEX idx_permission_rules_space_id ON permission_rules(space_id)")
  for (const trigger of RULE_HISTORY) database.exec(trigger)
}

export const vaultKeyRules: Migration = {
  version: 170,
  name: "vault_key_rules",
  foreignKeys: { kind: "rebuilds", tables: ["permission_rules"] },
  up
}
