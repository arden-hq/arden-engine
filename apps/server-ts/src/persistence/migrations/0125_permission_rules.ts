import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

export const permissionRules: Migration = {
  version: 125,
  name: "permission_rules",
  foreignKeys: { kind: "rebuilds", tables: ["permission_changes", "permission_rules"] },
  up: (database) => {
    for (const name of [
      "standing_permission_granted",
      "standing_permission_revoked",
      "command_permission_granted",
      "command_permission_revoked"
    ])
      database.exec(`DROP TRIGGER ${name}`)
    database.exec("ALTER TABLE permission_changes RENAME TO permission_changes_prior")
    database.exec(permissionChanges)
    database.exec(`INSERT INTO permission_changes (
        change_id, permission_kind, permission_id, action, principal, server_name, tool_name,
        argument_count, previous_mode, next_mode, source_question_id, source_session_id,
        source_run_id, source_tool_call_id, occurred_at, recorded_at
      )
      SELECT change_id, permission_kind, permission_id, action, principal, server_name, tool_name,
        argument_count, previous_mode, next_mode, source_question_id, source_session_id,
        source_run_id, source_tool_call_id, occurred_at, recorded_at
      FROM permission_changes_prior`)
    database.exec("DROP TABLE permission_changes_prior")
    for (const statement of [...afterHistory, ...ruleTable]) database.exec(statement)
    convertToolSettings(database)
    database.exec(`INSERT INTO permission_rules (
        rule_id, list_kind, desk_id, subject_kind, tool_name, server_name, decision,
        source_kind, source_run_id, source_tool_call_id, source_question_id, created_at
      )
      SELECT grant_row.permission_id, 'space', desk.desk_id, 'tool', grant_row.tool_name,
        grant_row.server_name, 'allow',
        CASE WHEN grant_row.source_question_id IS NOT NULL THEN 'offer'
          WHEN carded THEN 'card' ELSE 'migrated' END,
        CASE WHEN grant_row.source_question_id IS NULL AND carded THEN grant_row.source_run_id END,
        CASE WHEN grant_row.source_question_id IS NULL AND carded
          THEN grant_row.source_tool_call_id END,
        grant_row.source_question_id, grant_row.granted_at
      FROM (SELECT *, source_run_id IS NOT NULL AND source_tool_call_id IS NOT NULL AS carded
        FROM standing_permissions) AS grant_row
      JOIN desks AS desk ON grant_row.principal = 'desk:' || desk.desk_id
      WHERE desk.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM permission_rules AS asks
          WHERE asks.list_kind = 'global' AND asks.subject_kind = 'tool'
            AND asks.tool_name = grant_row.tool_name AND asks.decision = 'ask')`)
    database.exec(`INSERT INTO permission_rules (
        rule_id, list_kind, subject_kind, executable_path, argument_prefix_json, decision,
        source_kind, source_run_id, source_tool_call_id, created_at
      )
      SELECT permission_id, 'global', 'command', executable_path, json(argument_prefix_json),
        'allow', CASE WHEN carded THEN 'card' ELSE 'migrated' END,
        CASE WHEN carded THEN source_run_id END, CASE WHEN carded THEN source_tool_call_id END,
        granted_at
      FROM (SELECT *, source_run_id IS NOT NULL AND source_tool_call_id IS NOT NULL AS carded
        FROM command_permissions)`)
    database.exec(`INSERT INTO permission_rules (
        rule_id, list_kind, subject_kind, decision, source_kind, created_at
      )
      SELECT 'host-commands-' || lower(hex(randomblob(8))), 'global', 'host_commands', 'ask',
        'migrated', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM monitor_state
      WHERE namespace = 'command_settings' AND CASE
        WHEN NOT json_valid(state) THEN 1
        WHEN json_type(state) != 'object' THEN 1
        WHEN json_type(state, '$.host_always_ask') = 'false'
          AND (SELECT count(*) FROM json_each(state)) = 1 THEN 0
        ELSE 1 END`)
    database.exec("DELETE FROM monitor_state WHERE namespace = 'command_settings'")
    for (const table of ["standing_permissions", "command_permissions", "tool_settings"])
      database.exec(`DROP TABLE ${table}`)
  }
}

const DECISION: Readonly<Record<string, string>> = {
  approve: "allow",
  ask: "ask",
  deny: "never"
}

const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  "agent_knowledge_digest",
  "agent_knowledge_import",
  "agent_knowledge_scan",
  "agent_message",
  "answer_block_read",
  "app_open",
  "approval_mode_set",
  "artifact_delete",
  "artifact_export",
  "artifact_save",
  "ask_user",
  "automation_create",
  "automation_delete",
  "automation_diagnose",
  "automation_followup",
  "automation_list",
  "automation_list_runs",
  "automation_run",
  "automation_run_events",
  "automation_update",
  "browser_act",
  "browser_ask_secret",
  "browser_close",
  "browser_history_summary",
  "browser_open",
  "browser_permission",
  "browser_pointer",
  "browser_procedure",
  "browser_procedure_verify",
  "browser_screenshot",
  "browser_snapshot",
  "browser_tabs",
  "browser_task",
  "browser_upload",
  "browser_wait",
  "calendar_create_event",
  "calendar_delete_event",
  "calendar_edit_event",
  "calendar_free_busy",
  "calendar_list_calendars",
  "calendar_read_event",
  "calendar_respond",
  "calendar_search",
  "capability_propose",
  "chat_files_list",
  "claim_check",
  "claim_record",
  "claim_review",
  "code_mode",
  "computer_act",
  "computer_clipboard_write",
  "computer_launch",
  "computer_read",
  "computer_repl",
  "computer_reset",
  "connection_item_read",
  "connection_items_state",
  "current_time",
  "desk_archive",
  "desk_board_read",
  "desk_create",
  "desk_inference_review",
  "desk_list",
  "desk_page_create",
  "desk_page_patch",
  "desk_page_read",
  "desk_page_write",
  "desk_review_finish",
  "desk_settings_update",
  "directives_get",
  "directives_set",
  "drive_append_sheet_rows",
  "drive_create_doc",
  "drive_create_sheet",
  "drive_edit_doc",
  "drive_list_doc_tabs",
  "drive_read_doc",
  "drive_read_sheet",
  "drive_search",
  "drive_share_file",
  "drive_update_sheet",
  "drive_upload",
  "email_attachment_save",
  "email_draft",
  "email_forward",
  "email_label_list",
  "email_read",
  "email_reply",
  "email_search",
  "email_send",
  "email_thread_read",
  "email_thread_search",
  "email_trash",
  "email_unsubscribe",
  "email_update",
  "evidence_record",
  "exec_command",
  "file_edit",
  "file_find",
  "file_list",
  "file_read",
  "file_search_text",
  "file_write",
  "forward_message",
  "google_accounts_list",
  "google_client_import",
  "item_move",
  "model_catalog",
  "report",
  "run_inspect",
  "session_archive",
  "session_create",
  "session_list",
  "session_move",
  "session_read",
  "session_rename",
  "session_search_transcripts",
  "session_send_message",
  "set_activity",
  "set_chat_summary",
  "show_tour",
  "skill",
  "skill_create",
  "skill_list",
  "skill_update",
  "spawn_agent",
  "task_comment",
  "task_contract_propose",
  "task_criterion_met",
  "task_finish",
  "task_get",
  "task_move_here",
  "task_propose",
  "task_save_result",
  "task_start",
  "task_update",
  "task_wait",
  "tell",
  "thread_bring_back",
  "todo_update",
  "usage_limits",
  "usage_report",
  "web_fetch",
  "web_search",
  "wiki_apply_patch_set",
  "wiki_archive_page",
  "wiki_configure_reports",
  "wiki_create_directory",
  "wiki_create_page",
  "wiki_edit_page",
  "wiki_links",
  "wiki_list_changes",
  "wiki_list_collections",
  "wiki_list_pages",
  "wiki_move_page",
  "wiki_page_history",
  "wiki_patch_page",
  "wiki_publish_report",
  "wiki_read_change",
  "wiki_read_page",
  "wiki_restore_page",
  "wiki_search",
  "workflow_cancel",
  "workflow_get",
  "workflow_retry",
  "write_stdin"
])

const convertToolSettings = (database: DatabaseSync): void => {
  const row = database
    .prepare("SELECT overrides_json FROM tool_settings WHERE singleton_id = 1")
    .get()
  const stored = row?.["overrides_json"]
  if (typeof stored !== "string") return
  const overrides: unknown = JSON.parse(stored)
  if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) return
  const servers = database
    .prepare("SELECT name FROM mcp_servers")
    .all()
    .flatMap((server) => (typeof server["name"] === "string" ? [server["name"]] : []))
  const insert = database.prepare(`INSERT INTO permission_rules (
      rule_id, list_kind, subject_kind, tool_name, server_name, decision, source_kind, created_at
    ) VALUES (
      'tool-' || lower(hex(randomblob(8))), 'global', 'tool', ?, ?, ?, 'migrated',
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )`)
  for (const [tool, setting] of Object.entries(overrides)) {
    const decision = typeof setting === "string" ? DECISION[setting] : undefined
    if (decision === undefined) continue
    const server = tool.startsWith("mcp__") ? connectorOf(tool, servers) : null
    if (server === undefined || (server === null && !KNOWN_TOOLS.has(tool))) continue
    insert.run(tool, server, decision)
  }
}

const connectorOf = (tool: string, servers: ReadonlyArray<string>): string | undefined =>
  servers
    .filter((server) => tool.startsWith(`mcp__${server}__`))
    .reduce<string | undefined>(
      (longest, server) =>
        longest === undefined || server.length > longest.length ? server : longest,
      undefined
    )

const permissionChanges = `CREATE TABLE permission_changes (
      change_id INTEGER PRIMARY KEY AUTOINCREMENT,
      permission_kind TEXT NOT NULL
        CHECK(permission_kind IN ('standing', 'command', 'override', 'rule')),
      permission_id TEXT,
      action TEXT NOT NULL CHECK(action IN ('baseline', 'granted', 'revoked', 'changed')),
      principal TEXT,
      subject_kind TEXT,
      server_name TEXT,
      tool_name TEXT,
      argument_count INTEGER CHECK(argument_count IS NULL OR argument_count >= 0),
      previous_mode TEXT,
      next_mode TEXT,
      source_question_id TEXT,
      source_session_id TEXT,
      source_run_id TEXT,
      source_tool_call_id TEXT,
      occurred_at TEXT,
      recorded_at TEXT NOT NULL,
      CHECK((source_run_id IS NULL) = (source_tool_call_id IS NULL)),
      CHECK((permission_kind = 'override') = (permission_id IS NULL)),
      CHECK(permission_kind != 'override' OR (tool_name IS NOT NULL AND action IN ('baseline', 'changed'))),
      CHECK(permission_kind != 'command' OR argument_count IS NOT NULL),
      CHECK((permission_kind = 'rule') = (subject_kind IS NOT NULL))
    )`

const afterHistory = [
  `CREATE INDEX idx_permission_changes_permission
      ON permission_changes(permission_kind, permission_id, change_id)`,
  `CREATE TRIGGER permission_changes_immutable BEFORE UPDATE ON permission_changes
      BEGIN SELECT RAISE(ABORT, 'Permission history is immutable'); END`
]

const ruleTable = [
  `CREATE TABLE permission_rules (
      rule_id TEXT PRIMARY KEY CHECK(length(rule_id) > 0),
      list_kind TEXT NOT NULL CHECK(list_kind IN ('global', 'space', 'system')),
      desk_id TEXT REFERENCES desks(desk_id) ON DELETE CASCADE,
      subject_kind TEXT NOT NULL
        CHECK(subject_kind IN ('tool', 'connector', 'command', 'host_commands', 'words')),
      tool_name TEXT CHECK(tool_name IS NULL OR length(tool_name) BETWEEN 1 AND 256),
      server_name TEXT REFERENCES mcp_servers(name) ON DELETE CASCADE,
      executable_path TEXT CHECK(executable_path IS NULL OR length(executable_path) > 0),
      argument_prefix_json TEXT CHECK(argument_prefix_json IS NULL OR
        (json_valid(argument_prefix_json) AND json_type(argument_prefix_json) = 'array')),
      words TEXT CHECK(words IS NULL OR length(words) BETWEEN 1 AND 2000),
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
      CHECK(subject_kind != 'host_commands' OR decision = 'ask'),
      CHECK((source_run_id IS NULL) = (source_tool_call_id IS NULL)),
      CHECK(source_kind = 'card' OR source_run_id IS NULL),
      CHECK(source_kind = 'offer' OR source_question_id IS NULL)
    )`,
  `CREATE UNIQUE INDEX idx_permission_rules_identity ON permission_rules(
      list_kind, COALESCE(desk_id, ''), subject_kind, COALESCE(tool_name, ''),
      COALESCE(server_name, ''), COALESCE(executable_path, ''),
      COALESCE(argument_prefix_json, ''), COALESCE(words, ''))`,
  `CREATE TRIGGER desk_archive_drops_rules AFTER UPDATE OF archived_at ON desks
      WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL BEGIN
      DELETE FROM permission_rules WHERE list_kind = 'space' AND desk_id = NEW.desk_id;
    END`,
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
