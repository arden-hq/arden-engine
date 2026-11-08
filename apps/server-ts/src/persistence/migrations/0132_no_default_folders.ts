import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const revisionsInsert = `CREATE TRIGGER desk_revisions_insert AFTER INSERT ON desks WHEN 1
      BEGIN
        INSERT INTO desk_revisions (desk_id, version, kind, state_json, recorded_at) SELECT NEW.desk_id, COALESCE((SELECT MAX(version) FROM desk_revisions WHERE desk_id = NEW.desk_id), 0) + 1, 'created', json_object('name', NEW.name, 'instructions', NEW.instructions, 'instructions_source', NEW.instructions_source, 'page_path', NEW.page_path, 'page_id', NEW.page_id, 'inference_policy', NEW.inference_policy, 'archived_at', NEW.archived_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE 1;
      END`

const revisionsUpdate = `CREATE TRIGGER desk_revisions_update BEFORE UPDATE OF name, instructions, instructions_source, page_path, page_id, inference_policy, archived_at ON desks
      WHEN (1) AND json_object('name', OLD.name, 'instructions', OLD.instructions, 'instructions_source', OLD.instructions_source, 'page_path', OLD.page_path, 'page_id', OLD.page_id, 'inference_policy', OLD.inference_policy, 'archived_at', OLD.archived_at) IS NOT json_object('name', NEW.name, 'instructions', NEW.instructions, 'instructions_source', NEW.instructions_source, 'page_path', NEW.page_path, 'page_id', NEW.page_id, 'inference_policy', NEW.inference_policy, 'archived_at', NEW.archived_at)
      BEGIN
        INSERT INTO desk_revisions (desk_id, version, kind, state_json, recorded_at) SELECT OLD.desk_id, COALESCE((SELECT MAX(version) FROM desk_revisions WHERE desk_id = OLD.desk_id), 0) + 1, 'baseline', json_object('name', OLD.name, 'instructions', OLD.instructions, 'instructions_source', OLD.instructions_source, 'page_path', OLD.page_path, 'page_id', OLD.page_id, 'inference_policy', OLD.inference_policy, 'archived_at', OLD.archived_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE NOT EXISTS (SELECT 1 FROM desk_revisions WHERE desk_id = OLD.desk_id);
        INSERT INTO desk_revisions (desk_id, version, kind, state_json, recorded_at) SELECT NEW.desk_id, COALESCE((SELECT MAX(version) FROM desk_revisions WHERE desk_id = NEW.desk_id), 0) + 1, 'changed', json_object('name', NEW.name, 'instructions', NEW.instructions, 'instructions_source', NEW.instructions_source, 'page_path', NEW.page_path, 'page_id', NEW.page_id, 'inference_policy', NEW.inference_policy, 'archived_at', NEW.archived_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE 1;
      END`

const sessionRevisionsInsert = `CREATE TRIGGER session_revisions_insert AFTER INSERT ON sessions WHEN 1
      BEGIN
        INSERT INTO session_revisions (session_id, version, kind, state_json, recorded_at) SELECT NEW.session_id, COALESCE((SELECT MAX(version) FROM session_revisions WHERE session_id = NEW.session_id), 0) + 1, 'created', json_object('name', NEW.name, 'archived_at', NEW.archived_at, 'session_type', NEW.session_type, 'origin_automation_id', NEW.origin_automation_id, 'parent_session_id', NEW.parent_session_id, 'parent_run_id', NEW.parent_run_id, 'parent_tool_call_id', NEW.parent_tool_call_id, 'parent_message_id', NEW.parent_message_id, 'desk_id', NEW.desk_id, 'chat_model', NEW.chat_model, 'approval_mode', json_extract(CASE WHEN json_valid(NEW.metadata) THEN NEW.metadata ELSE '{}' END, '$.approval_mode'), 'metadata_valid', (NEW.metadata IS NULL OR json_valid(NEW.metadata))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE 1;
      END`

const sessionRevisionsUpdate = `CREATE TRIGGER session_revisions_update BEFORE UPDATE OF name, archived_at, session_type, origin_automation_id, parent_session_id, parent_run_id, parent_tool_call_id, parent_message_id, desk_id, chat_model, metadata ON sessions
      WHEN (1) AND json_object('name', OLD.name, 'archived_at', OLD.archived_at, 'session_type', OLD.session_type, 'origin_automation_id', OLD.origin_automation_id, 'parent_session_id', OLD.parent_session_id, 'parent_run_id', OLD.parent_run_id, 'parent_tool_call_id', OLD.parent_tool_call_id, 'parent_message_id', OLD.parent_message_id, 'desk_id', OLD.desk_id, 'chat_model', OLD.chat_model, 'approval_mode', json_extract(CASE WHEN json_valid(OLD.metadata) THEN OLD.metadata ELSE '{}' END, '$.approval_mode'), 'metadata_valid', (OLD.metadata IS NULL OR json_valid(OLD.metadata))) IS NOT json_object('name', NEW.name, 'archived_at', NEW.archived_at, 'session_type', NEW.session_type, 'origin_automation_id', NEW.origin_automation_id, 'parent_session_id', NEW.parent_session_id, 'parent_run_id', NEW.parent_run_id, 'parent_tool_call_id', NEW.parent_tool_call_id, 'parent_message_id', NEW.parent_message_id, 'desk_id', NEW.desk_id, 'chat_model', NEW.chat_model, 'approval_mode', json_extract(CASE WHEN json_valid(NEW.metadata) THEN NEW.metadata ELSE '{}' END, '$.approval_mode'), 'metadata_valid', (NEW.metadata IS NULL OR json_valid(NEW.metadata)))
      BEGIN
        INSERT INTO session_revisions (session_id, version, kind, state_json, recorded_at) SELECT OLD.session_id, COALESCE((SELECT MAX(version) FROM session_revisions WHERE session_id = OLD.session_id), 0) + 1, 'baseline', json_object('name', OLD.name, 'archived_at', OLD.archived_at, 'session_type', OLD.session_type, 'origin_automation_id', OLD.origin_automation_id, 'parent_session_id', OLD.parent_session_id, 'parent_run_id', OLD.parent_run_id, 'parent_tool_call_id', OLD.parent_tool_call_id, 'parent_message_id', OLD.parent_message_id, 'desk_id', OLD.desk_id, 'chat_model', OLD.chat_model, 'approval_mode', json_extract(CASE WHEN json_valid(OLD.metadata) THEN OLD.metadata ELSE '{}' END, '$.approval_mode'), 'metadata_valid', (OLD.metadata IS NULL OR json_valid(OLD.metadata))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE NOT EXISTS (SELECT 1 FROM session_revisions WHERE session_id = OLD.session_id);
        INSERT INTO session_revisions (session_id, version, kind, state_json, recorded_at) SELECT NEW.session_id, COALESCE((SELECT MAX(version) FROM session_revisions WHERE session_id = NEW.session_id), 0) + 1, 'changed', json_object('name', NEW.name, 'archived_at', NEW.archived_at, 'session_type', NEW.session_type, 'origin_automation_id', NEW.origin_automation_id, 'parent_session_id', NEW.parent_session_id, 'parent_run_id', NEW.parent_run_id, 'parent_tool_call_id', NEW.parent_tool_call_id, 'parent_message_id', NEW.parent_message_id, 'desk_id', NEW.desk_id, 'chat_model', NEW.chat_model, 'approval_mode', json_extract(CASE WHEN json_valid(NEW.metadata) THEN NEW.metadata ELSE '{}' END, '$.approval_mode'), 'metadata_valid', (NEW.metadata IS NULL OR json_valid(NEW.metadata))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE 1;
      END`

const revokeAttempts = `CREATE TRIGGER desk_revoke_task_attempts AFTER UPDATE OF archived_at, inference_policy ON desks
      WHEN (NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL)
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

const up = (database: DatabaseSync): void => {
  database.exec("DROP TRIGGER desk_revisions_insert")
  database.exec("DROP TRIGGER desk_revisions_update")
  database.exec("DROP TRIGGER desk_revoke_task_attempts")
  database.exec("DROP TRIGGER session_revisions_insert")
  database.exec("DROP TRIGGER session_revisions_update")
  database.exec("ALTER TABLE desks DROP COLUMN default_cwds")
  database.exec(revisionsInsert)
  database.exec(revisionsUpdate)
  database.exec(revokeAttempts)
  database.exec(sessionRevisionsInsert)
  database.exec(sessionRevisionsUpdate)
  database.exec(`UPDATE sessions
    SET metadata = json_remove(metadata, '$.local_folders', '$.code_agent_folders')
    WHERE json_valid(metadata)
      AND (json_type(metadata, '$.local_folders') IS NOT NULL
        OR json_type(metadata, '$.code_agent_folders') IS NOT NULL)`)
}

export const noDefaultFolders: Migration = {
  version: 132,
  name: "no_default_folders",
  foreignKeys: { kind: "enforced" },
  up
}
