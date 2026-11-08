import type { Migration } from "./index.js"

const deskRevisionsInsert = `CREATE TRIGGER desk_revisions_insert AFTER INSERT ON desks WHEN 1
      BEGIN
        INSERT INTO desk_revisions (desk_id, version, kind, state_json, recorded_at) SELECT NEW.desk_id, COALESCE((SELECT MAX(version) FROM desk_revisions WHERE desk_id = NEW.desk_id), 0) + 1, 'created', json_object('name', NEW.name, 'default_cwds', NEW.default_cwds, 'instructions', NEW.instructions, 'instructions_source', NEW.instructions_source, 'page_path', NEW.page_path, 'page_id', NEW.page_id, 'inference_policy', NEW.inference_policy, 'archived_at', NEW.archived_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE 1;
      END`

const deskRevisionsUpdate = `CREATE TRIGGER desk_revisions_update BEFORE UPDATE OF name, default_cwds, instructions, instructions_source, page_path, page_id, inference_policy, archived_at ON desks
      WHEN (1) AND json_object('name', OLD.name, 'default_cwds', OLD.default_cwds, 'instructions', OLD.instructions, 'instructions_source', OLD.instructions_source, 'page_path', OLD.page_path, 'page_id', OLD.page_id, 'inference_policy', OLD.inference_policy, 'archived_at', OLD.archived_at) IS NOT json_object('name', NEW.name, 'default_cwds', NEW.default_cwds, 'instructions', NEW.instructions, 'instructions_source', NEW.instructions_source, 'page_path', NEW.page_path, 'page_id', NEW.page_id, 'inference_policy', NEW.inference_policy, 'archived_at', NEW.archived_at)
      BEGIN
        INSERT INTO desk_revisions (desk_id, version, kind, state_json, recorded_at) SELECT OLD.desk_id, COALESCE((SELECT MAX(version) FROM desk_revisions WHERE desk_id = OLD.desk_id), 0) + 1, 'baseline', json_object('name', OLD.name, 'default_cwds', OLD.default_cwds, 'instructions', OLD.instructions, 'instructions_source', OLD.instructions_source, 'page_path', OLD.page_path, 'page_id', OLD.page_id, 'inference_policy', OLD.inference_policy, 'archived_at', OLD.archived_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE NOT EXISTS (SELECT 1 FROM desk_revisions WHERE desk_id = OLD.desk_id);
        INSERT INTO desk_revisions (desk_id, version, kind, state_json, recorded_at) SELECT NEW.desk_id, COALESCE((SELECT MAX(version) FROM desk_revisions WHERE desk_id = NEW.desk_id), 0) + 1, 'changed', json_object('name', NEW.name, 'default_cwds', NEW.default_cwds, 'instructions', NEW.instructions, 'instructions_source', NEW.instructions_source, 'page_path', NEW.page_path, 'page_id', NEW.page_id, 'inference_policy', NEW.inference_policy, 'archived_at', NEW.archived_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE 1;
      END`

const deskRevokeTaskAttempts = `CREATE TRIGGER desk_revoke_task_attempts AFTER UPDATE OF archived_at, default_cwds, inference_policy ON desks
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

export const removeDeskPause: Migration = {
  version: 112,
  name: "remove_desk_pause",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    const now = new Date().toISOString()
    database
      .prepare(
        `UPDATE desk_tasks SET status = 'deferred', next_attempt_at = NULL, updated_at = ?
        WHERE (status = 'open' OR (status = 'deferred' AND next_attempt_at IS NOT NULL))
          AND owner = 'worker' AND archived_at IS NULL
          AND desk_id IN (SELECT desk_id FROM desks WHERE paused_at IS NOT NULL)`
      )
      .run(now)
    database
      .prepare(
        `UPDATE desks SET inference_policy = json_set(inference_policy, '$.enabled', json('false')),
          updated_at = ?
        WHERE paused_at IS NOT NULL AND json_extract(inference_policy, '$.enabled') = 1`
      )
      .run(now)
    database.exec("DROP TRIGGER desk_revisions_insert")
    database.exec("DROP TRIGGER desk_revisions_update")
    database.exec("DROP TRIGGER desk_revoke_task_attempts")
    database.exec("ALTER TABLE desks DROP COLUMN paused_at")
    database.exec(deskRevisionsInsert)
    database.exec(deskRevisionsUpdate)
    database.exec(deskRevokeTaskAttempts)
  }
}
