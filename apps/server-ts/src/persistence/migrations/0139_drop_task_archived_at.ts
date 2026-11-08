import type { Migration } from "./index.js"

const taskRevokeAttempts = `CREATE TRIGGER task_revoke_attempts AFTER UPDATE OF status, owner ON desk_tasks
      WHEN (NEW.status <> OLD.status AND NEW.status <> 'open')
        OR NEW.owner <> OLD.owner
      BEGIN
        UPDATE desk_tasks SET generation = OLD.generation + 1 WHERE item_id = NEW.item_id;
        UPDATE run_questions SET closed_at = NEW.updated_at
          WHERE resolution IS NULL AND closed_at IS NULL
            AND (NEW.status IN ('done', 'cancelled') OR NEW.owner <> OLD.owner)
            AND run_id IN (SELECT run_id FROM chat_runs
              WHERE json_extract(metadata_json, '$.run_context.task.item_id') = NEW.item_id);
        UPDATE deferred_tool_calls SET status = 'rejected', resolved_at = NEW.updated_at
          WHERE status = 'pending'
            AND (NEW.status IN ('done', 'cancelled') OR NEW.owner <> OLD.owner)
            AND run_id IN (SELECT run_id FROM chat_runs
              WHERE json_extract(metadata_json, '$.run_context.task.item_id') = NEW.item_id);
        UPDATE automation_deliveries SET status = 'discarded',
          payload = json_set(payload, '$.withdrawal', json_object('at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'reason', 'task_changed'))
          WHERE status = 'pending' AND json_extract(payload, '$.kind') = 'answer'
            AND json_extract(payload, '$.context.task.item_id') = NEW.item_id;
      END`

const taskClearHold = `CREATE TRIGGER task_clear_hold AFTER UPDATE OF blocked, waiting_on, generation, status ON desk_tasks
      WHEN NEW.blocked = 0 OR NEW.waiting_on IS NOT OLD.waiting_on OR NEW.generation <> OLD.generation
        OR NEW.status <> 'open'
      BEGIN
        DELETE FROM desk_task_holds WHERE item_id = NEW.item_id
          AND (NEW.blocked = 0 OR NEW.waiting_on IS NOT OLD.waiting_on
            OR NEW.status <> 'open');
        UPDATE desk_task_holds SET task_generation = NEW.generation WHERE item_id = NEW.item_id;
      END`

const inChatIndex = `CREATE UNIQUE INDEX idx_desk_tasks_in_chat
      ON desk_tasks(home_session_id)
      WHERE runs_in = 'chat' AND status IN ('open', 'deferred')`

const revisionsInsert = `CREATE TRIGGER desk_task_revisions_insert AFTER INSERT ON desk_tasks
      BEGIN
        INSERT INTO desk_task_revisions (item_id, version, kind, state_json, recorded_at) SELECT NEW.item_id, COALESCE((SELECT MAX(version) FROM desk_task_revisions WHERE item_id = NEW.item_id), 0) + 1, 'created', json_object('desk_id', NEW.desk_id, 'home_session_id', NEW.home_session_id, 'stable_key', NEW.stable_key, 'text', NEW.text, 'body', NEW.body, 'status', NEW.status, 'owner', NEW.owner, 'runs_in', NEW.runs_in, 'token_budget', NEW.token_budget, 'blocked', NEW.blocked, 'waiting_on', NEW.waiting_on, 'due_at', NEW.due_at, 'next_attempt_at', NEW.next_attempt_at, 'completed_at', NEW.completed_at, 'created_by', NEW.created_by, 'capture', NEW.capture, 'continuation_context', NEW.continuation_context, 'origin_message_id', NEW.origin_message_id, 'original_body', NEW.original_body, 'sources', json(COALESCE((SELECT json_group_array(json(source)) FROM (SELECT source FROM desk_task_sources WHERE item_id = NEW.item_id ORDER BY source_key)), '[]'))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ;
      END`

const revisionsUpdate = `CREATE TRIGGER desk_task_revisions_update BEFORE UPDATE OF desk_id, home_session_id, stable_key, text, body, status, owner, runs_in, token_budget, blocked, waiting_on, due_at, next_attempt_at, completed_at, created_by, capture, continuation_context, origin_message_id, original_body ON desk_tasks
      WHEN NEW.desk_id IS NOT OLD.desk_id OR NEW.home_session_id IS NOT OLD.home_session_id OR NEW.stable_key IS NOT OLD.stable_key OR NEW.text IS NOT OLD.text OR NEW.body IS NOT OLD.body OR NEW.status IS NOT OLD.status OR NEW.owner IS NOT OLD.owner OR NEW.runs_in IS NOT OLD.runs_in OR NEW.token_budget IS NOT OLD.token_budget OR NEW.blocked IS NOT OLD.blocked OR NEW.waiting_on IS NOT OLD.waiting_on OR NEW.due_at IS NOT OLD.due_at OR NEW.next_attempt_at IS NOT OLD.next_attempt_at OR NEW.completed_at IS NOT OLD.completed_at OR NEW.created_by IS NOT OLD.created_by OR NEW.capture IS NOT OLD.capture OR NEW.continuation_context IS NOT OLD.continuation_context OR NEW.origin_message_id IS NOT OLD.origin_message_id OR NEW.original_body IS NOT OLD.original_body
      BEGIN
        INSERT INTO desk_task_revisions (item_id, version, kind, state_json, recorded_at) SELECT OLD.item_id, COALESCE((SELECT MAX(version) FROM desk_task_revisions WHERE item_id = OLD.item_id), 0) + 1, 'baseline', json_object('desk_id', OLD.desk_id, 'home_session_id', OLD.home_session_id, 'stable_key', OLD.stable_key, 'text', OLD.text, 'body', OLD.body, 'status', OLD.status, 'owner', OLD.owner, 'runs_in', OLD.runs_in, 'token_budget', OLD.token_budget, 'blocked', OLD.blocked, 'waiting_on', OLD.waiting_on, 'due_at', OLD.due_at, 'next_attempt_at', OLD.next_attempt_at, 'completed_at', OLD.completed_at, 'created_by', OLD.created_by, 'capture', OLD.capture, 'continuation_context', OLD.continuation_context, 'origin_message_id', OLD.origin_message_id, 'original_body', OLD.original_body, 'sources', json(COALESCE((SELECT json_group_array(json(source)) FROM (SELECT source FROM desk_task_sources WHERE item_id = OLD.item_id ORDER BY source_key)), '[]'))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE NOT EXISTS (SELECT 1 FROM desk_task_revisions WHERE item_id = OLD.item_id);
        INSERT INTO desk_task_revisions (item_id, version, kind, state_json, recorded_at) SELECT NEW.item_id, COALESCE((SELECT MAX(version) FROM desk_task_revisions WHERE item_id = NEW.item_id), 0) + 1, 'changed', json_object('desk_id', NEW.desk_id, 'home_session_id', NEW.home_session_id, 'stable_key', NEW.stable_key, 'text', NEW.text, 'body', NEW.body, 'status', NEW.status, 'owner', NEW.owner, 'runs_in', NEW.runs_in, 'token_budget', NEW.token_budget, 'blocked', NEW.blocked, 'waiting_on', NEW.waiting_on, 'due_at', NEW.due_at, 'next_attempt_at', NEW.next_attempt_at, 'completed_at', NEW.completed_at, 'created_by', NEW.created_by, 'capture', NEW.capture, 'continuation_context', NEW.continuation_context, 'origin_message_id', NEW.origin_message_id, 'original_body', NEW.original_body, 'sources', json(COALESCE((SELECT json_group_array(json(source)) FROM (SELECT source FROM desk_task_sources WHERE item_id = NEW.item_id ORDER BY source_key)), '[]'))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ;
      END`

const revisionsSourceInsert = `CREATE TRIGGER desk_task_revisions_source_insert AFTER INSERT ON desk_task_sources
      BEGIN
        INSERT INTO desk_task_revisions (item_id, version, kind, state_json, recorded_at)
        SELECT entity.item_id, 1, 'baseline', json_object('desk_id', entity.desk_id, 'home_session_id', entity.home_session_id, 'stable_key', entity.stable_key, 'text', entity.text, 'body', entity.body, 'status', entity.status, 'owner', entity.owner, 'runs_in', entity.runs_in, 'token_budget', entity.token_budget, 'blocked', entity.blocked, 'waiting_on', entity.waiting_on, 'due_at', entity.due_at, 'next_attempt_at', entity.next_attempt_at, 'completed_at', entity.completed_at, 'created_by', entity.created_by, 'capture', entity.capture, 'continuation_context', entity.continuation_context, 'origin_message_id', entity.origin_message_id, 'original_body', entity.original_body, 'sources', json(COALESCE((SELECT json_group_array(json(source)) FROM (SELECT source FROM desk_task_sources WHERE item_id = entity.item_id AND source_key <> NEW.source_key ORDER BY source_key)), '[]'))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM desk_tasks AS entity
        WHERE entity.item_id = NEW.item_id AND NOT EXISTS (SELECT 1 FROM desk_task_revisions WHERE item_id = entity.item_id);
        INSERT INTO desk_task_revisions (item_id, version, kind, state_json, recorded_at)
        SELECT entity.item_id, (SELECT MAX(version) + 1 FROM desk_task_revisions WHERE item_id = entity.item_id), 'changed', json_object('desk_id', entity.desk_id, 'home_session_id', entity.home_session_id, 'stable_key', entity.stable_key, 'text', entity.text, 'body', entity.body, 'status', entity.status, 'owner', entity.owner, 'runs_in', entity.runs_in, 'token_budget', entity.token_budget, 'blocked', entity.blocked, 'waiting_on', entity.waiting_on, 'due_at', entity.due_at, 'next_attempt_at', entity.next_attempt_at, 'completed_at', entity.completed_at, 'created_by', entity.created_by, 'capture', entity.capture, 'continuation_context', entity.continuation_context, 'origin_message_id', entity.origin_message_id, 'original_body', entity.original_body, 'sources', json(COALESCE((SELECT json_group_array(json(source)) FROM (SELECT source FROM desk_task_sources WHERE item_id = entity.item_id ORDER BY source_key)), '[]'))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        FROM desk_tasks AS entity WHERE entity.item_id = NEW.item_id;
      END`

const revisionsSourceDelete = `CREATE TRIGGER desk_task_revisions_source_delete BEFORE DELETE ON desk_task_sources
      BEGIN
        INSERT INTO desk_task_revisions (item_id, version, kind, state_json, recorded_at)
        SELECT entity.item_id, 1, 'baseline', json_object('desk_id', entity.desk_id, 'home_session_id', entity.home_session_id, 'stable_key', entity.stable_key, 'text', entity.text, 'body', entity.body, 'status', entity.status, 'owner', entity.owner, 'runs_in', entity.runs_in, 'token_budget', entity.token_budget, 'blocked', entity.blocked, 'waiting_on', entity.waiting_on, 'due_at', entity.due_at, 'next_attempt_at', entity.next_attempt_at, 'completed_at', entity.completed_at, 'created_by', entity.created_by, 'capture', entity.capture, 'continuation_context', entity.continuation_context, 'origin_message_id', entity.origin_message_id, 'original_body', entity.original_body, 'sources', json(COALESCE((SELECT json_group_array(json(source)) FROM (SELECT source FROM desk_task_sources WHERE item_id = entity.item_id ORDER BY source_key)), '[]'))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM desk_tasks AS entity
        WHERE entity.item_id = OLD.item_id AND NOT EXISTS (SELECT 1 FROM desk_task_revisions WHERE item_id = entity.item_id);
        INSERT INTO desk_task_revisions (item_id, version, kind, state_json, recorded_at)
        SELECT entity.item_id, (SELECT MAX(version) + 1 FROM desk_task_revisions WHERE item_id = entity.item_id), 'changed', json_object('desk_id', entity.desk_id, 'home_session_id', entity.home_session_id, 'stable_key', entity.stable_key, 'text', entity.text, 'body', entity.body, 'status', entity.status, 'owner', entity.owner, 'runs_in', entity.runs_in, 'token_budget', entity.token_budget, 'blocked', entity.blocked, 'waiting_on', entity.waiting_on, 'due_at', entity.due_at, 'next_attempt_at', entity.next_attempt_at, 'completed_at', entity.completed_at, 'created_by', entity.created_by, 'capture', entity.capture, 'continuation_context', entity.continuation_context, 'origin_message_id', entity.origin_message_id, 'original_body', entity.original_body, 'sources', json(COALESCE((SELECT json_group_array(json(source)) FROM (SELECT source FROM desk_task_sources WHERE item_id = entity.item_id AND source_key <> OLD.source_key ORDER BY source_key)), '[]'))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        FROM desk_tasks AS entity WHERE entity.item_id = OLD.item_id;
      END`

export const dropTaskArchivedAt: Migration = {
  version: 139,
  name: "drop_task_archived_at",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec("DROP TRIGGER task_revoke_attempts")
    database.exec("DROP TRIGGER task_clear_hold")
    database.exec("DROP TRIGGER desk_task_revisions_insert")
    database.exec("DROP TRIGGER desk_task_revisions_update")
    database.exec("DROP TRIGGER desk_task_revisions_source_insert")
    database.exec("DROP TRIGGER desk_task_revisions_source_delete")
    database.exec("DROP INDEX idx_desk_tasks_in_chat")
    database.exec(
      "UPDATE desk_tasks SET stable_key = 'retired:' || item_id WHERE archived_at IS NOT NULL"
    )
    database.exec("ALTER TABLE desk_tasks DROP COLUMN archived_at")
    database.exec(taskRevokeAttempts)
    database.exec(taskClearHold)
    database.exec(inChatIndex)
    database.exec(revisionsInsert)
    database.exec(revisionsUpdate)
    database.exec(revisionsSourceInsert)
    database.exec(revisionsSourceDelete)
  }
}
