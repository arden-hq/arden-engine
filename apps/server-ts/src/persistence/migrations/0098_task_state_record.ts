import type { Migration } from "./index.js"

export const taskStateRecord: Migration = {
  version: 98,
  name: "task_state_record",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(`UPDATE desk_tasks SET continuation_context = NULL
      WHERE continuation_context IS NOT NULL AND trim(continuation_context) = ''`)
    database.exec(`UPDATE desk_tasks
      SET continuation_context = json_object(
        'done', json('[]'), 'in_progress', json('[]'), 'decided', json('[]'),
        'rejected', json('[]'),
        'next', json_array('Earlier notes, not yet sorted into this record: ' || continuation_context),
        'written_at', updated_at, 'run_id', NULL)
      WHERE continuation_context IS NOT NULL
        AND NOT (json_valid(continuation_context)
          AND json_type(continuation_context) = 'object'
          AND json_type(continuation_context, '$.next') = 'array')`)
  }
}
