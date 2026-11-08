import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

export const taskToolNames: Migration = {
  version: 43,
  name: "task_tool_names",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    renameToolSettings(database)
    database.exec("DROP TRIGGER worker_attempt_state")
    database.exec(workerAttemptState)
  }
}

const RENAMED: Readonly<Record<string, ReadonlyArray<string>>> = {
  desk_task_create: ["task_start"],
  desk_task_update: ["task_update", "task_wait", "task_finish"],
  desk_task_comment: ["task_comment"],
  desk_task_follow: ["task_follow"],
  desk_task_save_result: ["task_save_result"],
  desk_task_undo: ["task_undo"]
}

const renameToolSettings = (database: DatabaseSync): void => {
  const row = database
    .prepare("SELECT overrides_json FROM tool_settings WHERE singleton_id = 1")
    .get()
  const stored = row?.["overrides_json"]
  if (typeof stored !== "string") return
  const overrides: unknown = JSON.parse(stored)
  if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) return
  const next: Record<string, unknown> = { ...overrides }
  for (const [old, names] of Object.entries(RENAMED)) {
    if (!(old in next)) continue
    const setting = next[old]
    delete next[old]
    for (const name of names) if (!(name in next)) next[name] = setting
  }
  database
    .prepare("UPDATE tool_settings SET overrides_json = ? WHERE singleton_id = 1")
    .run(JSON.stringify(next))
}

const workerAttemptState = `CREATE TRIGGER worker_attempt_state
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
              WHEN json_extract(NEW.metadata_json, '$.no_change_reason') IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM tool_calls AS call WHERE call.run_id = NEW.run_id
                  AND CASE
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
                AND NOT EXISTS (SELECT 1 FROM run_questions WHERE run_id = NEW.run_id) THEN 'no_change'
              ELSE 'completed' END
            ELSE 'failed' END,
          result = CASE WHEN NEW.status = 'completed' THEN COALESCE(
            json_extract(NEW.metadata_json, '$.terminal_result.text'),
            (SELECT json_extract(message_json, '$.content') FROM session_messages
              WHERE session_id = NEW.session_id AND message_id = NEW.assistant_message_id)
          ) ELSE NULL END,
          error = NEW.error_message
        WHERE chat_run_id = NEW.run_id AND task_id IS NULL;
      END`
