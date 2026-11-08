import type { OperationalSchemaSection } from "../section.js"

export const contextHistorySchemaSection = {
  name: "context.history",
  storageDomain: "configuration",
  tables: [
    "space_mutation_links",
    "session_mutation_links",
    "automation_configuration_mutation_links",
    "space_revisions",
    "session_revisions",
    "automation_configuration_revisions",
    "session_membership_changes"
  ],
  indexes: [
    "idx_space_mutation_links_call",
    "idx_session_mutation_links_call",
    "idx_automation_configuration_mutation_links_call",
    "idx_session_membership_operation"
  ],
  triggers: [
    "space_mutation_links_immutable",
    "session_mutation_links_immutable",
    "automation_configuration_mutation_links_immutable",
    "space_revisions_insert",
    "space_revisions_update",
    "space_revisions_immutable_update",
    "session_revisions_insert",
    "session_revisions_update",
    "session_revisions_immutable_update",
    "automation_configuration_revisions_insert",
    "automation_configuration_revisions_update",
    "automation_configuration_revisions_immutable_update",
    "session_membership_changes_immutable_update"
  ],
  statements: [
    `CREATE TABLE space_mutation_links (
      space_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      PRIMARY KEY (space_id, version),
      FOREIGN KEY (space_id, version) REFERENCES space_revisions(space_id, version) ON DELETE CASCADE,
      FOREIGN KEY (run_id, tool_call_id) REFERENCES tool_calls(run_id, tool_call_id) ON DELETE CASCADE
    )`,
    `CREATE INDEX idx_space_mutation_links_call ON space_mutation_links(run_id, tool_call_id)`,
    `CREATE TRIGGER space_mutation_links_immutable BEFORE UPDATE ON space_mutation_links BEGIN SELECT RAISE(ABORT, 'Mutation links are immutable'); END`,
    `CREATE TABLE session_mutation_links (
      session_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      PRIMARY KEY (session_id, version),
      FOREIGN KEY (session_id, version) REFERENCES session_revisions(session_id, version) ON DELETE CASCADE,
      FOREIGN KEY (run_id, tool_call_id) REFERENCES tool_calls(run_id, tool_call_id) ON DELETE CASCADE
    )`,
    `CREATE INDEX idx_session_mutation_links_call ON session_mutation_links(run_id, tool_call_id)`,
    `CREATE TRIGGER session_mutation_links_immutable BEFORE UPDATE ON session_mutation_links BEGIN SELECT RAISE(ABORT, 'Mutation links are immutable'); END`,
    `CREATE TABLE automation_configuration_mutation_links (
      task_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      PRIMARY KEY (task_id, version),
      FOREIGN KEY (task_id, version) REFERENCES automation_configuration_revisions(task_id, version) ON DELETE CASCADE,
      FOREIGN KEY (run_id, tool_call_id) REFERENCES tool_calls(run_id, tool_call_id) ON DELETE CASCADE
    )`,
    `CREATE INDEX idx_automation_configuration_mutation_links_call ON automation_configuration_mutation_links(run_id, tool_call_id)`,
    `CREATE TRIGGER automation_configuration_mutation_links_immutable BEFORE UPDATE ON automation_configuration_mutation_links BEGIN SELECT RAISE(ABORT, 'Mutation links are immutable'); END`,
    `CREATE TABLE space_revisions (
      space_id TEXT NOT NULL REFERENCES spaces(space_id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK(version >= 1),
      kind TEXT NOT NULL CHECK(kind IN ('baseline', 'created', 'changed')),
      state_json TEXT NOT NULL CHECK(json_valid(state_json)),
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (space_id, version)
    )`,
    `CREATE TRIGGER space_revisions_insert AFTER INSERT ON spaces WHEN 1
      BEGIN
        INSERT INTO space_revisions (space_id, version, kind, state_json, recorded_at) SELECT NEW.space_id, COALESCE((SELECT MAX(version) FROM space_revisions WHERE space_id = NEW.space_id), 0) + 1, 'created', json_object('name', NEW.name, 'instructions', NEW.instructions, 'instructions_source', NEW.instructions_source, 'page_path', NEW.page_path, 'page_id', NEW.page_id, 'inference_policy', NEW.inference_policy, 'archived_at', NEW.archived_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE 1;
      END`,
    `CREATE TRIGGER space_revisions_update BEFORE UPDATE OF name, instructions, instructions_source, page_path, page_id, inference_policy, archived_at ON spaces
      WHEN (1) AND json_object('name', OLD.name, 'instructions', OLD.instructions, 'instructions_source', OLD.instructions_source, 'page_path', OLD.page_path, 'page_id', OLD.page_id, 'inference_policy', OLD.inference_policy, 'archived_at', OLD.archived_at) IS NOT json_object('name', NEW.name, 'instructions', NEW.instructions, 'instructions_source', NEW.instructions_source, 'page_path', NEW.page_path, 'page_id', NEW.page_id, 'inference_policy', NEW.inference_policy, 'archived_at', NEW.archived_at)
      BEGIN
        INSERT INTO space_revisions (space_id, version, kind, state_json, recorded_at) SELECT OLD.space_id, COALESCE((SELECT MAX(version) FROM space_revisions WHERE space_id = OLD.space_id), 0) + 1, 'baseline', json_object('name', OLD.name, 'instructions', OLD.instructions, 'instructions_source', OLD.instructions_source, 'page_path', OLD.page_path, 'page_id', OLD.page_id, 'inference_policy', OLD.inference_policy, 'archived_at', OLD.archived_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE NOT EXISTS (SELECT 1 FROM space_revisions WHERE space_id = OLD.space_id);
        INSERT INTO space_revisions (space_id, version, kind, state_json, recorded_at) SELECT NEW.space_id, COALESCE((SELECT MAX(version) FROM space_revisions WHERE space_id = NEW.space_id), 0) + 1, 'changed', json_object('name', NEW.name, 'instructions', NEW.instructions, 'instructions_source', NEW.instructions_source, 'page_path', NEW.page_path, 'page_id', NEW.page_id, 'inference_policy', NEW.inference_policy, 'archived_at', NEW.archived_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE 1;
      END`,
    `CREATE TRIGGER space_revisions_immutable_update BEFORE UPDATE ON space_revisions
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
        INSERT INTO session_revisions (session_id, version, kind, state_json, recorded_at) SELECT NEW.session_id, COALESCE((SELECT MAX(version) FROM session_revisions WHERE session_id = NEW.session_id), 0) + 1, 'created', json_object('name', NEW.name, 'archived_at', NEW.archived_at, 'session_type', NEW.session_type, 'origin_automation_id', NEW.origin_automation_id, 'parent_session_id', NEW.parent_session_id, 'parent_run_id', NEW.parent_run_id, 'parent_tool_call_id', NEW.parent_tool_call_id, 'parent_message_id', NEW.parent_message_id, 'space_id', NEW.space_id, 'chat_model', NEW.chat_model, 'approval_mode', json_extract(CASE WHEN json_valid(NEW.metadata) THEN NEW.metadata ELSE '{}' END, '$.approval_mode'), 'metadata_valid', (NEW.metadata IS NULL OR json_valid(NEW.metadata))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE 1;
      END`,
    `CREATE TRIGGER session_revisions_update BEFORE UPDATE OF name, archived_at, session_type, origin_automation_id, parent_session_id, parent_run_id, parent_tool_call_id, parent_message_id, space_id, chat_model, metadata ON sessions
      WHEN (1) AND json_object('name', OLD.name, 'archived_at', OLD.archived_at, 'session_type', OLD.session_type, 'origin_automation_id', OLD.origin_automation_id, 'parent_session_id', OLD.parent_session_id, 'parent_run_id', OLD.parent_run_id, 'parent_tool_call_id', OLD.parent_tool_call_id, 'parent_message_id', OLD.parent_message_id, 'space_id', OLD.space_id, 'chat_model', OLD.chat_model, 'approval_mode', json_extract(CASE WHEN json_valid(OLD.metadata) THEN OLD.metadata ELSE '{}' END, '$.approval_mode'), 'metadata_valid', (OLD.metadata IS NULL OR json_valid(OLD.metadata))) IS NOT json_object('name', NEW.name, 'archived_at', NEW.archived_at, 'session_type', NEW.session_type, 'origin_automation_id', NEW.origin_automation_id, 'parent_session_id', NEW.parent_session_id, 'parent_run_id', NEW.parent_run_id, 'parent_tool_call_id', NEW.parent_tool_call_id, 'parent_message_id', NEW.parent_message_id, 'space_id', NEW.space_id, 'chat_model', NEW.chat_model, 'approval_mode', json_extract(CASE WHEN json_valid(NEW.metadata) THEN NEW.metadata ELSE '{}' END, '$.approval_mode'), 'metadata_valid', (NEW.metadata IS NULL OR json_valid(NEW.metadata)))
      BEGIN
        INSERT INTO session_revisions (session_id, version, kind, state_json, recorded_at) SELECT OLD.session_id, COALESCE((SELECT MAX(version) FROM session_revisions WHERE session_id = OLD.session_id), 0) + 1, 'baseline', json_object('name', OLD.name, 'archived_at', OLD.archived_at, 'session_type', OLD.session_type, 'origin_automation_id', OLD.origin_automation_id, 'parent_session_id', OLD.parent_session_id, 'parent_run_id', OLD.parent_run_id, 'parent_tool_call_id', OLD.parent_tool_call_id, 'parent_message_id', OLD.parent_message_id, 'space_id', OLD.space_id, 'chat_model', OLD.chat_model, 'approval_mode', json_extract(CASE WHEN json_valid(OLD.metadata) THEN OLD.metadata ELSE '{}' END, '$.approval_mode'), 'metadata_valid', (OLD.metadata IS NULL OR json_valid(OLD.metadata))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE NOT EXISTS (SELECT 1 FROM session_revisions WHERE session_id = OLD.session_id);
        INSERT INTO session_revisions (session_id, version, kind, state_json, recorded_at) SELECT NEW.session_id, COALESCE((SELECT MAX(version) FROM session_revisions WHERE session_id = NEW.session_id), 0) + 1, 'changed', json_object('name', NEW.name, 'archived_at', NEW.archived_at, 'session_type', NEW.session_type, 'origin_automation_id', NEW.origin_automation_id, 'parent_session_id', NEW.parent_session_id, 'parent_run_id', NEW.parent_run_id, 'parent_tool_call_id', NEW.parent_tool_call_id, 'parent_message_id', NEW.parent_message_id, 'space_id', NEW.space_id, 'chat_model', NEW.chat_model, 'approval_mode', json_extract(CASE WHEN json_valid(NEW.metadata) THEN NEW.metadata ELSE '{}' END, '$.approval_mode'), 'metadata_valid', (NEW.metadata IS NULL OR json_valid(NEW.metadata))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE 1;
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
        INSERT INTO automation_configuration_revisions (task_id, version, kind, state_json, recorded_at) SELECT NEW.task_id, COALESCE((SELECT MAX(version) FROM automation_configuration_revisions WHERE task_id = NEW.task_id), 0) + 1, 'created', json_object('name', NEW.name, 'description', NEW.description, 'description_source', NEW.description_source, 'enabled', NEW.enabled, 'auto_approve', NEW.auto_approve, 'tool_scope', NEW.tool_scope, 'purpose', NEW.purpose, 'owner_space_id', NEW.owner_space_id, 'owner_task_id', NEW.owner_task_id, 'instruction_revision_id', NEW.instruction_revision_id), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE 1;
      END`,
    `CREATE TRIGGER automation_configuration_revisions_update BEFORE UPDATE OF name, description, description_source, enabled, auto_approve, tool_scope, purpose, owner_space_id, owner_task_id, instruction_revision_id ON scheduled_tasks
      WHEN (NEW.purpose = 'user_automation' AND NEW.builtin = 0) AND json_object('name', OLD.name, 'description', OLD.description, 'description_source', OLD.description_source, 'enabled', OLD.enabled, 'auto_approve', OLD.auto_approve, 'tool_scope', OLD.tool_scope, 'purpose', OLD.purpose, 'owner_space_id', OLD.owner_space_id, 'owner_task_id', OLD.owner_task_id, 'instruction_revision_id', OLD.instruction_revision_id) IS NOT json_object('name', NEW.name, 'description', NEW.description, 'description_source', NEW.description_source, 'enabled', NEW.enabled, 'auto_approve', NEW.auto_approve, 'tool_scope', NEW.tool_scope, 'purpose', NEW.purpose, 'owner_space_id', NEW.owner_space_id, 'owner_task_id', NEW.owner_task_id, 'instruction_revision_id', NEW.instruction_revision_id)
      BEGIN
        INSERT INTO automation_configuration_revisions (task_id, version, kind, state_json, recorded_at) SELECT OLD.task_id, COALESCE((SELECT MAX(version) FROM automation_configuration_revisions WHERE task_id = OLD.task_id), 0) + 1, 'baseline', json_object('name', OLD.name, 'description', OLD.description, 'description_source', OLD.description_source, 'enabled', OLD.enabled, 'auto_approve', OLD.auto_approve, 'tool_scope', OLD.tool_scope, 'purpose', OLD.purpose, 'owner_space_id', OLD.owner_space_id, 'owner_task_id', OLD.owner_task_id, 'instruction_revision_id', OLD.instruction_revision_id), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE NOT EXISTS (SELECT 1 FROM automation_configuration_revisions WHERE task_id = OLD.task_id);
        INSERT INTO automation_configuration_revisions (task_id, version, kind, state_json, recorded_at) SELECT NEW.task_id, COALESCE((SELECT MAX(version) FROM automation_configuration_revisions WHERE task_id = NEW.task_id), 0) + 1, 'changed', json_object('name', NEW.name, 'description', NEW.description, 'description_source', NEW.description_source, 'enabled', NEW.enabled, 'auto_approve', NEW.auto_approve, 'tool_scope', NEW.tool_scope, 'purpose', NEW.purpose, 'owner_space_id', NEW.owner_space_id, 'owner_task_id', NEW.owner_task_id, 'instruction_revision_id', NEW.instruction_revision_id), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE 1;
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
} as const satisfies OperationalSchemaSection
