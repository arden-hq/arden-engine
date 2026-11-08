import type { Migration } from "./index.js"

const statements = [
  `CREATE TABLE desk_revisions (
      desk_id TEXT NOT NULL REFERENCES desks(desk_id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK(version >= 1),
      kind TEXT NOT NULL CHECK(kind IN ('baseline', 'created', 'changed')),
      state_json TEXT NOT NULL CHECK(json_valid(state_json)),
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (desk_id, version)
    )`,
  `CREATE TRIGGER desk_revisions_insert AFTER INSERT ON desks WHEN 1
      BEGIN
        INSERT INTO desk_revisions (desk_id, version, kind, state_json, recorded_at) SELECT NEW.desk_id, COALESCE((SELECT MAX(version) FROM desk_revisions WHERE desk_id = NEW.desk_id), 0) + 1, 'created', json_object('name', NEW.name, 'default_cwds', NEW.default_cwds, 'instructions', NEW.instructions, 'instructions_source', NEW.instructions_source, 'page_path', NEW.page_path, 'page_id', NEW.page_id, 'inference_policy', NEW.inference_policy, 'paused_at', NEW.paused_at, 'archived_at', NEW.archived_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE 1;
      END`,
  `CREATE TRIGGER desk_revisions_update BEFORE UPDATE OF name, default_cwds, instructions, instructions_source, page_path, page_id, inference_policy, paused_at, archived_at ON desks
      WHEN (1) AND json_object('name', OLD.name, 'default_cwds', OLD.default_cwds, 'instructions', OLD.instructions, 'instructions_source', OLD.instructions_source, 'page_path', OLD.page_path, 'page_id', OLD.page_id, 'inference_policy', OLD.inference_policy, 'paused_at', OLD.paused_at, 'archived_at', OLD.archived_at) IS NOT json_object('name', NEW.name, 'default_cwds', NEW.default_cwds, 'instructions', NEW.instructions, 'instructions_source', NEW.instructions_source, 'page_path', NEW.page_path, 'page_id', NEW.page_id, 'inference_policy', NEW.inference_policy, 'paused_at', NEW.paused_at, 'archived_at', NEW.archived_at)
      BEGIN
        INSERT INTO desk_revisions (desk_id, version, kind, state_json, recorded_at) SELECT OLD.desk_id, COALESCE((SELECT MAX(version) FROM desk_revisions WHERE desk_id = OLD.desk_id), 0) + 1, 'baseline', json_object('name', OLD.name, 'default_cwds', OLD.default_cwds, 'instructions', OLD.instructions, 'instructions_source', OLD.instructions_source, 'page_path', OLD.page_path, 'page_id', OLD.page_id, 'inference_policy', OLD.inference_policy, 'paused_at', OLD.paused_at, 'archived_at', OLD.archived_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE NOT EXISTS (SELECT 1 FROM desk_revisions WHERE desk_id = OLD.desk_id);
        INSERT INTO desk_revisions (desk_id, version, kind, state_json, recorded_at) SELECT NEW.desk_id, COALESCE((SELECT MAX(version) FROM desk_revisions WHERE desk_id = NEW.desk_id), 0) + 1, 'changed', json_object('name', NEW.name, 'default_cwds', NEW.default_cwds, 'instructions', NEW.instructions, 'instructions_source', NEW.instructions_source, 'page_path', NEW.page_path, 'page_id', NEW.page_id, 'inference_policy', NEW.inference_policy, 'paused_at', NEW.paused_at, 'archived_at', NEW.archived_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE 1;
      END`,
  `CREATE TRIGGER desk_revisions_immutable_update BEFORE UPDATE ON desk_revisions
      BEGIN SELECT RAISE(ABORT, 'Context history versions are immutable'); END`,
  `CREATE TABLE session_revisions (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK(version >= 1),
      kind TEXT NOT NULL CHECK(kind IN ('baseline', 'created', 'changed')),
      state_json TEXT NOT NULL CHECK(json_valid(state_json)),
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (session_id, version)
    )`,
  `CREATE TRIGGER session_revisions_insert AFTER INSERT ON sessions WHEN 1
      BEGIN
        INSERT INTO session_revisions (session_id, version, kind, state_json, recorded_at) SELECT NEW.session_id, COALESCE((SELECT MAX(version) FROM session_revisions WHERE session_id = NEW.session_id), 0) + 1, 'created', json_object('name', NEW.name, 'archived_at', NEW.archived_at, 'session_type', NEW.session_type, 'origin_automation_id', NEW.origin_automation_id, 'parent_session_id', NEW.parent_session_id, 'parent_run_id', NEW.parent_run_id, 'parent_tool_call_id', NEW.parent_tool_call_id, 'parent_message_id', NEW.parent_message_id, 'desk_id', NEW.desk_id, 'chat_model', NEW.chat_model, 'approval_mode', json_extract(CASE WHEN json_valid(NEW.metadata) THEN NEW.metadata ELSE '{}' END, '$.approval_mode'), 'local_folders', json_extract(CASE WHEN json_valid(NEW.metadata) THEN NEW.metadata ELSE '{}' END, '$.local_folders'), 'code_agent_folders', json_extract(CASE WHEN json_valid(NEW.metadata) THEN NEW.metadata ELSE '{}' END, '$.code_agent_folders'), 'metadata_valid', (NEW.metadata IS NULL OR json_valid(NEW.metadata))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE 1;
      END`,
  `CREATE TRIGGER session_revisions_update BEFORE UPDATE OF name, archived_at, session_type, origin_automation_id, parent_session_id, parent_run_id, parent_tool_call_id, parent_message_id, desk_id, chat_model, metadata ON sessions
      WHEN (1) AND json_object('name', OLD.name, 'archived_at', OLD.archived_at, 'session_type', OLD.session_type, 'origin_automation_id', OLD.origin_automation_id, 'parent_session_id', OLD.parent_session_id, 'parent_run_id', OLD.parent_run_id, 'parent_tool_call_id', OLD.parent_tool_call_id, 'parent_message_id', OLD.parent_message_id, 'desk_id', OLD.desk_id, 'chat_model', OLD.chat_model, 'approval_mode', json_extract(CASE WHEN json_valid(OLD.metadata) THEN OLD.metadata ELSE '{}' END, '$.approval_mode'), 'local_folders', json_extract(CASE WHEN json_valid(OLD.metadata) THEN OLD.metadata ELSE '{}' END, '$.local_folders'), 'code_agent_folders', json_extract(CASE WHEN json_valid(OLD.metadata) THEN OLD.metadata ELSE '{}' END, '$.code_agent_folders'), 'metadata_valid', (OLD.metadata IS NULL OR json_valid(OLD.metadata))) IS NOT json_object('name', NEW.name, 'archived_at', NEW.archived_at, 'session_type', NEW.session_type, 'origin_automation_id', NEW.origin_automation_id, 'parent_session_id', NEW.parent_session_id, 'parent_run_id', NEW.parent_run_id, 'parent_tool_call_id', NEW.parent_tool_call_id, 'parent_message_id', NEW.parent_message_id, 'desk_id', NEW.desk_id, 'chat_model', NEW.chat_model, 'approval_mode', json_extract(CASE WHEN json_valid(NEW.metadata) THEN NEW.metadata ELSE '{}' END, '$.approval_mode'), 'local_folders', json_extract(CASE WHEN json_valid(NEW.metadata) THEN NEW.metadata ELSE '{}' END, '$.local_folders'), 'code_agent_folders', json_extract(CASE WHEN json_valid(NEW.metadata) THEN NEW.metadata ELSE '{}' END, '$.code_agent_folders'), 'metadata_valid', (NEW.metadata IS NULL OR json_valid(NEW.metadata)))
      BEGIN
        INSERT INTO session_revisions (session_id, version, kind, state_json, recorded_at) SELECT OLD.session_id, COALESCE((SELECT MAX(version) FROM session_revisions WHERE session_id = OLD.session_id), 0) + 1, 'baseline', json_object('name', OLD.name, 'archived_at', OLD.archived_at, 'session_type', OLD.session_type, 'origin_automation_id', OLD.origin_automation_id, 'parent_session_id', OLD.parent_session_id, 'parent_run_id', OLD.parent_run_id, 'parent_tool_call_id', OLD.parent_tool_call_id, 'parent_message_id', OLD.parent_message_id, 'desk_id', OLD.desk_id, 'chat_model', OLD.chat_model, 'approval_mode', json_extract(CASE WHEN json_valid(OLD.metadata) THEN OLD.metadata ELSE '{}' END, '$.approval_mode'), 'local_folders', json_extract(CASE WHEN json_valid(OLD.metadata) THEN OLD.metadata ELSE '{}' END, '$.local_folders'), 'code_agent_folders', json_extract(CASE WHEN json_valid(OLD.metadata) THEN OLD.metadata ELSE '{}' END, '$.code_agent_folders'), 'metadata_valid', (OLD.metadata IS NULL OR json_valid(OLD.metadata))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE NOT EXISTS (SELECT 1 FROM session_revisions WHERE session_id = OLD.session_id);
        INSERT INTO session_revisions (session_id, version, kind, state_json, recorded_at) SELECT NEW.session_id, COALESCE((SELECT MAX(version) FROM session_revisions WHERE session_id = NEW.session_id), 0) + 1, 'changed', json_object('name', NEW.name, 'archived_at', NEW.archived_at, 'session_type', NEW.session_type, 'origin_automation_id', NEW.origin_automation_id, 'parent_session_id', NEW.parent_session_id, 'parent_run_id', NEW.parent_run_id, 'parent_tool_call_id', NEW.parent_tool_call_id, 'parent_message_id', NEW.parent_message_id, 'desk_id', NEW.desk_id, 'chat_model', NEW.chat_model, 'approval_mode', json_extract(CASE WHEN json_valid(NEW.metadata) THEN NEW.metadata ELSE '{}' END, '$.approval_mode'), 'local_folders', json_extract(CASE WHEN json_valid(NEW.metadata) THEN NEW.metadata ELSE '{}' END, '$.local_folders'), 'code_agent_folders', json_extract(CASE WHEN json_valid(NEW.metadata) THEN NEW.metadata ELSE '{}' END, '$.code_agent_folders'), 'metadata_valid', (NEW.metadata IS NULL OR json_valid(NEW.metadata))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE 1;
      END`,
  `CREATE TRIGGER session_revisions_immutable_update BEFORE UPDATE ON session_revisions
      BEGIN SELECT RAISE(ABORT, 'Context history versions are immutable'); END`,
  `CREATE TABLE automation_configuration_revisions (
      task_id TEXT NOT NULL REFERENCES scheduled_tasks(task_id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK(version >= 1),
      kind TEXT NOT NULL CHECK(kind IN ('baseline', 'created', 'changed')),
      state_json TEXT NOT NULL CHECK(json_valid(state_json)),
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (task_id, version)
    )`,
  `CREATE TRIGGER automation_configuration_revisions_insert AFTER INSERT ON scheduled_tasks WHEN NEW.purpose = 'user_automation' AND NEW.builtin = 0
      BEGIN
        INSERT INTO automation_configuration_revisions (task_id, version, kind, state_json, recorded_at) SELECT NEW.task_id, COALESCE((SELECT MAX(version) FROM automation_configuration_revisions WHERE task_id = NEW.task_id), 0) + 1, 'created', json_object('name', NEW.name, 'description', NEW.description, 'description_source', NEW.description_source, 'enabled', NEW.enabled, 'auto_approve', NEW.auto_approve, 'tool_scope', NEW.tool_scope, 'purpose', NEW.purpose, 'owner_desk_id', NEW.owner_desk_id, 'owner_task_id', NEW.owner_task_id, 'instruction_revision_id', NEW.instruction_revision_id), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE 1;
      END`,
  `CREATE TRIGGER automation_configuration_revisions_update BEFORE UPDATE OF name, description, description_source, enabled, auto_approve, tool_scope, purpose, owner_desk_id, owner_task_id, instruction_revision_id ON scheduled_tasks
      WHEN (NEW.purpose = 'user_automation' AND NEW.builtin = 0) AND json_object('name', OLD.name, 'description', OLD.description, 'description_source', OLD.description_source, 'enabled', OLD.enabled, 'auto_approve', OLD.auto_approve, 'tool_scope', OLD.tool_scope, 'purpose', OLD.purpose, 'owner_desk_id', OLD.owner_desk_id, 'owner_task_id', OLD.owner_task_id, 'instruction_revision_id', OLD.instruction_revision_id) IS NOT json_object('name', NEW.name, 'description', NEW.description, 'description_source', NEW.description_source, 'enabled', NEW.enabled, 'auto_approve', NEW.auto_approve, 'tool_scope', NEW.tool_scope, 'purpose', NEW.purpose, 'owner_desk_id', NEW.owner_desk_id, 'owner_task_id', NEW.owner_task_id, 'instruction_revision_id', NEW.instruction_revision_id)
      BEGIN
        INSERT INTO automation_configuration_revisions (task_id, version, kind, state_json, recorded_at) SELECT OLD.task_id, COALESCE((SELECT MAX(version) FROM automation_configuration_revisions WHERE task_id = OLD.task_id), 0) + 1, 'baseline', json_object('name', OLD.name, 'description', OLD.description, 'description_source', OLD.description_source, 'enabled', OLD.enabled, 'auto_approve', OLD.auto_approve, 'tool_scope', OLD.tool_scope, 'purpose', OLD.purpose, 'owner_desk_id', OLD.owner_desk_id, 'owner_task_id', OLD.owner_task_id, 'instruction_revision_id', OLD.instruction_revision_id), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE NOT EXISTS (SELECT 1 FROM automation_configuration_revisions WHERE task_id = OLD.task_id);
        INSERT INTO automation_configuration_revisions (task_id, version, kind, state_json, recorded_at) SELECT NEW.task_id, COALESCE((SELECT MAX(version) FROM automation_configuration_revisions WHERE task_id = NEW.task_id), 0) + 1, 'changed', json_object('name', NEW.name, 'description', NEW.description, 'description_source', NEW.description_source, 'enabled', NEW.enabled, 'auto_approve', NEW.auto_approve, 'tool_scope', NEW.tool_scope, 'purpose', NEW.purpose, 'owner_desk_id', NEW.owner_desk_id, 'owner_task_id', NEW.owner_task_id, 'instruction_revision_id', NEW.instruction_revision_id), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE 1;
      END`,
  `CREATE TRIGGER automation_configuration_revisions_immutable_update BEFORE UPDATE ON automation_configuration_revisions
      BEGIN SELECT RAISE(ABORT, 'Context history versions are immutable'); END`,
  `CREATE TABLE session_membership_changes (
      session_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      operation_id TEXT NOT NULL,
      PRIMARY KEY (session_id, version),
      FOREIGN KEY (session_id, version) REFERENCES session_revisions(session_id, version) ON DELETE CASCADE
    )`,
  `CREATE INDEX idx_session_membership_operation ON session_membership_changes(operation_id)`,
  `CREATE TRIGGER session_membership_changes_immutable_update BEFORE UPDATE ON session_membership_changes BEGIN SELECT RAISE(ABORT, 'Membership links are immutable'); END`
]

export const contextHistory: Migration = {
  version: 86,
  name: "context_history",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    for (const statement of statements) database.exec(statement)
  }
}
