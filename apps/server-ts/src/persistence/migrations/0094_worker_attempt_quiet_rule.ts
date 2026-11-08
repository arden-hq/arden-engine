import type { Migration } from "./index.js"

const trigger = `CREATE TRIGGER worker_attempt_state
      AFTER UPDATE OF status ON chat_runs
      BEGIN
        UPDATE automation_runs
        SET status = CASE WHEN NEW.status IN ('pending', 'running', 'backgrounded') THEN 'running'
            WHEN NEW.status IN ('completed', 'cancelled', 'interrupted') THEN NEW.status
            ELSE 'failed' END,
          ended_at = NEW.ended_at,
          disposition = CASE WHEN NEW.status IN ('pending', 'running', 'backgrounded') THEN NULL
            WHEN NEW.status = 'completed' THEN CASE
              WHEN EXISTS (SELECT 1 FROM run_questions WHERE run_id = NEW.run_id AND resolution IS NULL AND closed_at IS NULL)
                THEN 'needs_you'
              WHEN (
  json_extract(NEW.metadata_json, '$.no_change_reason') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM tool_calls AS call
    WHERE call.run_id = NEW.run_id AND CASE
  WHEN call.changes_state = 0 OR call.status IN ('ready', 'paused') THEN 'none'
  WHEN call.effect IN ('none', 'run_record') THEN 'none'
  WHEN COALESCE(json_extract(call.result_json, '$.host.mutation_receipt.outcome'), 'unknown') = 'no_op' THEN 'none'
  WHEN call.status = 'completed' AND json_extract(call.result_json, '$.is_error') = 0
    AND ((call.tool_name IN ('desk_task_update', 'task_update')
        AND (json_type(call.arguments_json, '$.patch.next_attempt_at') IS NOT NULL
          OR json_type(call.arguments_json, '$.patch.continuation_context') IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM json_each(call.arguments_json, '$.patch')
          WHERE key NOT IN ('next_attempt_at', 'continuation_context')))
      OR (call.tool_name = 'task_wait'
        AND json_type(call.arguments_json, '$.next_attempt_at') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM json_each(call.arguments_json)
          WHERE key NOT IN ('desk_id', 'key', 'expected_updated_at', 'next_attempt_at', 'continuation_context'))))
    AND EXISTS (SELECT 1 FROM automation_runs AS attempt
      JOIN desk_tasks AS task ON task.item_id = attempt.item_id
      WHERE attempt.chat_run_id = call.run_id AND attempt.task_id IS NOT NULL
        AND attempt.purpose = 'task_execution'
        AND task.stable_key = json_extract(call.arguments_json, '$.key')) THEN 'none'
  WHEN call.effect = 'arden_db' THEN 'arden'
  WHEN json_extract(call.result_json, '$.host.mutation_receipt.outcome') = 'applied' THEN 'applied'
  ELSE 'uncertain'
END != 'none')
  AND NOT EXISTS (SELECT 1 FROM tool_calls AS failed WHERE failed.run_id = NEW.run_id
    AND json_extract(failed.result_json, '$.is_error') = 1
    AND COALESCE(json_extract(failed.result_json, '$.data.outcome'), '') != 'invalid_arguments'
    AND COALESCE(failed.ended_at, '9') >= COALESCE((SELECT MAX(declared.started_at) FROM tool_calls AS declared
      WHERE declared.run_id = NEW.run_id AND declared.effect = 'run_record'
        AND COALESCE(json_extract(declared.result_json, '$.is_error'), 0) = 0
        AND 'no_change' IN (json_extract(declared.arguments_json, '$.event'),
          json_extract(declared.arguments_json, '$.kind'))), ''))
  AND NOT EXISTS (SELECT 1 FROM run_questions AS question WHERE question.run_id = NEW.run_id)
) THEN 'no_change'
              ELSE 'completed' END
            ELSE 'failed' END,
          result = CASE WHEN NEW.status = 'completed' THEN COALESCE(
            json_extract(NEW.metadata_json, '$.terminal_result.text'),
            (SELECT json_extract(message_json, '$.content') FROM session_messages
              WHERE session_id = NEW.session_id AND message_id = NEW.assistant_message_id)
          ) ELSE NULL END,
          error = NEW.error_message
        WHERE chat_run_id = NEW.run_id AND task_id IS NULL;
        UPDATE automation_runs
        SET outcome = CASE WHEN status = 'running' THEN NULL
            WHEN status IN ('failed', 'cancelled', 'interrupted') THEN status
            WHEN disposition = 'needs_you' THEN 'needs_you'
            WHEN EXISTS (SELECT 1 FROM run_sidecars AS sidecar WHERE sidecar.run_id = automation_runs.chat_run_id
              AND json_extract(sidecar.evidence_json, '$.automation_outcome') IS NOT NULL) THEN 'blocked'
            WHEN disposition = 'no_change' THEN 'no_change'
            ELSE 'finished' END
        WHERE chat_run_id = NEW.run_id AND task_id IS NULL;
      END`

export const workerAttemptQuietRule: Migration = {
  version: 94,
  name: "worker_attempt_quiet_rule",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec("DROP TRIGGER IF EXISTS worker_attempt_state")
    database.exec(trigger)
  }
}
