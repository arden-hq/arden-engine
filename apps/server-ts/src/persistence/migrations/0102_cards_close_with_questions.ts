import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const trigger = `CREATE TRIGGER task_revoke_attempts AFTER UPDATE OF status, owner, archived_at ON desk_tasks
      WHEN (NEW.status <> OLD.status AND NEW.status <> 'open')
        OR NEW.owner <> OLD.owner OR (NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL)
      BEGIN
        UPDATE desk_tasks SET generation = OLD.generation + 1 WHERE item_id = NEW.item_id;
        UPDATE run_questions SET closed_at = NEW.updated_at
          WHERE resolution IS NULL AND closed_at IS NULL
            AND (NEW.status IN ('done', 'cancelled') OR NEW.archived_at IS NOT NULL OR NEW.owner <> OLD.owner)
            AND run_id IN (SELECT run_id FROM chat_runs
              WHERE json_extract(metadata_json, '$.run_context.task.item_id') = NEW.item_id);
        UPDATE deferred_tool_calls SET status = 'rejected', resolved_at = NEW.updated_at
          WHERE status = 'pending'
            AND (NEW.status IN ('done', 'cancelled') OR NEW.archived_at IS NOT NULL OR NEW.owner <> OLD.owner)
            AND run_id IN (SELECT run_id FROM chat_runs
              WHERE json_extract(metadata_json, '$.run_context.task.item_id') = NEW.item_id);
        UPDATE automation_deliveries SET status = 'discarded',
          payload = json_set(payload, '$.withdrawal', json_object('at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'reason', 'task_changed'))
          WHERE status = 'pending' AND json_extract(payload, '$.kind') = 'answer'
            AND json_extract(payload, '$.context.task.item_id') = NEW.item_id;
      END`

const up = (database: DatabaseSync): void => {
  database.exec("DROP TRIGGER task_revoke_attempts")
  database.exec(trigger)
  database.exec(`UPDATE deferred_tool_calls
    SET status = 'rejected', resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE status = 'pending' AND run_id IN (
      SELECT run.run_id FROM chat_runs AS run
      WHERE run.run_id IN (SELECT run_id FROM deferred_tool_calls WHERE status = 'pending')
        AND (json_extract(run.metadata_json, '$.cancelled_by_run_id') IS NOT NULL
          OR EXISTS (SELECT 1 FROM desk_tasks AS task
            WHERE task.item_id = json_extract(run.metadata_json, '$.run_context.task.item_id')
              AND (task.status IN ('done', 'cancelled') OR task.archived_at IS NOT NULL))))`)
}

export const cardsCloseWithQuestions: Migration = {
  version: 102,
  name: "cards_close_with_questions",
  foreignKeys: { kind: "enforced" },
  up
}
