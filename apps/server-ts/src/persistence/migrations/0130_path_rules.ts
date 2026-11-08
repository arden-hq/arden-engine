import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const ruleTable = `CREATE TABLE permission_rules (
      rule_id TEXT PRIMARY KEY CHECK(length(rule_id) > 0),
      list_kind TEXT NOT NULL CHECK(list_kind IN ('global', 'space', 'system')),
      desk_id TEXT REFERENCES desks(desk_id) ON DELETE CASCADE,
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
      CHECK((list_kind = 'space') = (desk_id IS NOT NULL)),
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
    )`

const permissionOffers = `CREATE TABLE permission_offers (
      question_id TEXT PRIMARY KEY CHECK(length(question_id) > 0),
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      tool_name TEXT CHECK(tool_name IS NULL OR length(tool_name) BETWEEN 1 AND 256),
      server_name TEXT CHECK(server_name IS NULL OR length(server_name) > 0),
      change_json TEXT NOT NULL CHECK(json_valid(change_json)
        AND json_extract(change_json, '$.kind') IN ('tool', 'site', 'connector', 'mode', 'command', 'words', 'rule', 'path')),
      source_kind TEXT NOT NULL CHECK(source_kind IN ('message', 'approvals')),
      source_message_id TEXT,
      choices_json TEXT NOT NULL CHECK(json_valid(choices_json) AND json_type(choices_json) = 'array'),
      decision TEXT CHECK(decision IS NULL OR decision IN ('chat', 'desk', 'automation', 'everywhere', 'no')),
      created_at TEXT NOT NULL,
      settled_at TEXT,
      CHECK((json_extract(change_json, '$.kind') IN ('tool', 'site')) = (tool_name IS NOT NULL)),
      CHECK(json_extract(change_json, '$.kind') != 'connector' OR server_name IS NOT NULL),
      CHECK((source_kind = 'message') = (source_message_id IS NOT NULL)),
      CHECK((decision IS NULL) = (settled_at IS NULL))
    )`

const ruleIndex = `CREATE UNIQUE INDEX idx_permission_rules_identity ON permission_rules(
      list_kind, COALESCE(desk_id, ''), subject_kind, COALESCE(tool_name, ''),
      COALESCE(server_name, ''), COALESCE(executable_path, ''),
      COALESCE(argument_prefix_json, ''), COALESCE(words, ''), COALESCE(origin, ''),
      COALESCE(path, ''), COALESCE(access, ''))`

const ruleHistory = [
  `CREATE TRIGGER permission_rule_saved AFTER INSERT ON permission_rules BEGIN
      INSERT INTO permission_changes (
        permission_kind, permission_id, action, principal, subject_kind, server_name, tool_name,
        argument_count, next_mode, source_question_id, source_session_id, source_run_id,
        source_tool_call_id, occurred_at, recorded_at
      ) VALUES (
        'rule', NEW.rule_id, 'granted',
        CASE NEW.list_kind WHEN 'space' THEN 'space:' || NEW.desk_id ELSE NEW.list_kind END,
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
        CASE NEW.list_kind WHEN 'space' THEN 'space:' || NEW.desk_id ELSE NEW.list_kind END,
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
        CASE OLD.list_kind WHEN 'space' THEN 'space:' || OLD.desk_id ELSE OLD.list_kind END,
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

const revokeAttempts = `CREATE TRIGGER desk_revoke_task_attempts AFTER UPDATE OF archived_at, default_cwds, inference_policy ON desks
      WHEN (NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL)
        OR EXISTS (SELECT 1 FROM json_each(OLD.default_cwds) AS previous_folder
          WHERE NOT EXISTS (SELECT 1 FROM json_each(NEW.default_cwds) AS current_folder
            WHERE current_folder.value = previous_folder.value))
        OR (json_extract(OLD.inference_policy, '$.enabled') = 1 AND json_extract(NEW.inference_policy, '$.enabled') = 0)
      BEGIN
        UPDATE desks SET policy_generation = policy_generation + 1 WHERE desk_id = NEW.desk_id;
        UPDATE desk_tasks SET generation = generation + 1 WHERE desk_id = NEW.desk_id;
        UPDATE automation_deliveries SET status = 'discarded',
          payload = json_set(payload, '$.withdrawal', json_object('at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'reason', 'desk_policy_changed'))
          WHERE status = 'pending' AND json_extract(payload, '$.kind') = 'answer'
            AND json_extract(payload, '$.context.task.item_id') IN
              (SELECT item_id FROM desk_tasks WHERE desk_id = NEW.desk_id);
      END`

const canonical = (folder: string): string | undefined => {
  const home = homedir()
  let expanded = folder
  if (folder === "~") expanded = home
  else if (folder.startsWith("~/")) expanded = path.join(home, folder.slice(2))
  if (!path.isAbsolute(expanded)) return undefined
  const resolved = path.resolve(expanded)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

const folders = (raw: unknown): ReadonlyArray<string> => {
  if (typeof raw !== "string") return []
  const parsed: unknown = JSON.parse(raw)
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : []
}

const up = (database: DatabaseSync): void => {
  database.exec("PRAGMA legacy_alter_table = ON")
  try {
    database.exec("ALTER TABLE permission_rules RENAME TO permission_rules_prior")
  } finally {
    database.exec("PRAGMA legacy_alter_table = OFF")
  }
  database.exec(ruleTable)
  database.exec(`INSERT INTO permission_rules (
      rule_id, list_kind, desk_id, subject_kind, tool_name, server_name, executable_path,
      argument_prefix_json, words, origin, decision, source_kind, source_run_id,
      source_tool_call_id, source_question_id, created_at
    ) SELECT rule_id, list_kind, desk_id, subject_kind, tool_name, server_name, executable_path,
      argument_prefix_json, words, origin, decision, source_kind, source_run_id,
      source_tool_call_id, source_question_id, created_at
    FROM permission_rules_prior`)
  database.exec("DROP TABLE permission_rules_prior")
  database.exec("PRAGMA legacy_alter_table = ON")
  try {
    database.exec("ALTER TABLE permission_offers RENAME TO permission_offers_prior")
  } finally {
    database.exec("PRAGMA legacy_alter_table = OFF")
  }
  database.exec(permissionOffers)
  database.exec(`INSERT INTO permission_offers (
      question_id, session_id, tool_name, server_name, change_json, source_kind,
      source_message_id, choices_json, decision, created_at, settled_at
    ) SELECT question_id, session_id, tool_name, server_name, change_json, source_kind,
      source_message_id, choices_json, decision, created_at, settled_at
    FROM permission_offers_prior`)
  database.exec("DROP TABLE permission_offers_prior")
  database.exec(`CREATE INDEX idx_permission_offers_session_tool
      ON permission_offers(session_id, tool_name)`)
  database.exec(ruleIndex)
  for (const trigger of ruleHistory) database.exec(trigger)

  const insert = database.prepare(`INSERT OR IGNORE INTO permission_rules (
      rule_id, list_kind, desk_id, subject_kind, path, access, decision, source_kind, created_at
    ) VALUES (
      'path-' || lower(hex(randomblob(8))), ?, ?, 'path', ?, 'change', 'allow', 'migrated',
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )`)
  const desks = database
    .prepare("SELECT desk_id, default_cwds FROM desks WHERE archived_at IS NULL")
    .all()
  for (const desk of desks)
    for (const folder of folders(desk["default_cwds"])) {
      const kept = canonical(folder)
      if (kept !== undefined) insert.run("space", desk["desk_id"] as string, kept)
    }
  database.exec("DROP TRIGGER desk_revoke_task_attempts")
  database.exec(`UPDATE desks SET default_cwds = json_array(json_extract(default_cwds, '$[0]'))
    WHERE json_array_length(default_cwds) > 1`)
  database.exec(revokeAttempts)
  database.exec(`UPDATE sessions SET metadata = json_set(metadata, '$.local_folders',
      json_array(json_extract(metadata, '$.local_folders[0]')))
    WHERE desk_id IS NULL AND json_array_length(json_extract(metadata, '$.local_folders')) > 1`)
}

export const pathRules: Migration = {
  version: 130,
  name: "path_rules",
  foreignKeys: { kind: "rebuilds", tables: ["permission_rules", "permission_offers"] },
  up
}
