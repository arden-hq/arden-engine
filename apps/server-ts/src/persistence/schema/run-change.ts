export const CALL_CHANGE_SQL = `CASE
  WHEN call.changes_state = 0 OR call.status IN ('ready', 'paused') THEN 'none'
  WHEN call.effect IN ('none', 'run_record') THEN 'none'
  WHEN COALESCE(json_extract(call.result_json, '$.host.mutation_receipt.outcome'), 'unknown') = 'no_op' THEN 'none'
  WHEN call.status = 'completed' AND json_extract(call.result_json, '$.is_error') = 0
    AND ((call.tool_name IN ('space_task_update', 'task_update')
        AND (json_type(call.arguments_json, '$.patch.next_attempt_at') IS NOT NULL
          OR json_type(call.arguments_json, '$.patch.continuation_context') IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM json_each(call.arguments_json, '$.patch')
          WHERE key NOT IN ('next_attempt_at', 'continuation_context')))
      OR (call.tool_name = 'task_wait'
        AND json_type(call.arguments_json, '$.next_attempt_at') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM json_each(call.arguments_json)
          WHERE key NOT IN ('space_id', 'key', 'expected_updated_at', 'next_attempt_at', 'continuation_context'))))
    AND EXISTS (SELECT 1 FROM automation_runs AS attempt
      JOIN space_tasks AS task ON task.item_id = attempt.item_id
      WHERE attempt.chat_run_id = call.run_id AND attempt.task_id IS NOT NULL
        AND attempt.purpose = 'task_execution'
        AND task.stable_key = json_extract(call.arguments_json, '$.key')) THEN 'none'
  WHEN call.effect = 'arden_db' THEN 'arden'
  WHEN json_extract(call.result_json, '$.host.mutation_receipt.outcome') = 'applied' THEN 'applied'
  ELSE 'uncertain'
END`

export const runChangedSql = (runId: string): string =>
  `EXISTS (SELECT 1 FROM tool_calls AS call
    WHERE call.run_id = ${runId} AND ${CALL_CHANGE_SQL} != 'none')`

export const quietRunSql = (runId: string, metadata: string): string => `(
  json_extract(${metadata}, '$.no_change_reason') IS NOT NULL
  AND NOT ${runChangedSql(runId)}
  AND NOT EXISTS (SELECT 1 FROM tool_calls AS news WHERE news.run_id = ${runId}
    AND news.effect = 'run_record'
    AND COALESCE(json_extract(news.result_json, '$.is_error'), 0) = 0
    AND json_extract(news.arguments_json, '$.event') = 'news'
    AND news.started_at >= COALESCE((SELECT MAX(declared.started_at) FROM tool_calls AS declared
      WHERE declared.run_id = ${runId} AND declared.effect = 'run_record'
        AND COALESCE(json_extract(declared.result_json, '$.is_error'), 0) = 0
        AND 'no_change' IN (json_extract(declared.arguments_json, '$.event'),
          json_extract(declared.arguments_json, '$.kind'))), ''))
  AND NOT EXISTS (SELECT 1 FROM tool_calls AS failed WHERE failed.run_id = ${runId}
    AND json_extract(failed.result_json, '$.is_error') = 1
    AND COALESCE(json_extract(failed.result_json, '$.data.outcome'), '') != 'invalid_arguments'
    AND COALESCE(failed.ended_at, '9') >= COALESCE((SELECT MAX(declared.started_at) FROM tool_calls AS declared
      WHERE declared.run_id = ${runId} AND declared.effect = 'run_record'
        AND COALESCE(json_extract(declared.result_json, '$.is_error'), 0) = 0
        AND 'no_change' IN (json_extract(declared.arguments_json, '$.event'),
          json_extract(declared.arguments_json, '$.kind'))), ''))
  AND NOT EXISTS (SELECT 1 FROM run_questions AS question WHERE question.run_id = ${runId})
)`

export const declaredNewsSql = (
  runId: string
): string => `EXISTS (SELECT 1 FROM tool_calls AS declared
    WHERE declared.run_id = ${runId} AND declared.effect = 'run_record'
      AND COALESCE(json_extract(declared.result_json, '$.is_error'), 0) = 0
      AND json_extract(declared.arguments_json, '$.event') = 'news')`
