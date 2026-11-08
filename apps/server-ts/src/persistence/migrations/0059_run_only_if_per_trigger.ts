import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(`UPDATE scheduled_tasks SET triggers = (
      SELECT json_group_array(json(CASE WHEN json_extract(value, '$.type') = 'event'
        THEN json_set(value, '$.run_only_if', scheduled_tasks.prefilter) ELSE value END))
      FROM (SELECT value FROM json_each(scheduled_tasks.triggers) ORDER BY key)
    )
    WHERE prefilter IS NOT NULL AND json_valid(triggers)`)
  database.exec(`UPDATE automation_event_queue
    SET context = json_set(context, '$.run_only_if',
      json_array((SELECT prefilter FROM scheduled_tasks WHERE task_id = automation_event_queue.task_id)))
    WHERE source = 'event' AND json_valid(context)
      AND (SELECT prefilter FROM scheduled_tasks WHERE task_id = automation_event_queue.task_id) IS NOT NULL`)
  database.exec(`UPDATE automation_runs SET skip_json = json_object(
      'reason', 'prefilter',
      'backend', json_extract(skip_json, '$.backend'),
      'event', json_object(
        'event_type', json_extract(trigger_json, '$.event_type'),
        'title', COALESCE(
          CASE json_extract(trigger_json, '$.event_type')
            WHEN 'event_approaching' THEN NULLIF(trim(json_extract(trigger_json, '$.context.event.summary')), '')
            WHEN 'chat.quiet' THEN NULLIF(trim(json_extract(trigger_json, '$.context.chat.name')), '')
            WHEN 'wiki.changed' THEN json_extract(trigger_json, '$.context.change.paths[0]') ||
              CASE WHEN json_array_length(trigger_json, '$.context.change.paths') > 1
                THEN ' and ' || (json_array_length(trigger_json, '$.context.change.paths') - 1) || ' more'
                ELSE '' END
          END,
          CASE json_extract(trigger_json, '$.event_type')
            WHEN 'event_approaching' THEN 'Calendar event'
            WHEN 'chat.quiet' THEN 'Untitled chat'
            ELSE 'Memory changed'
          END),
        'link', CASE
          WHEN json_extract(trigger_json, '$.event_type') = 'chat.quiet'
            AND json_extract(trigger_json, '$.context.chat.session_id') IS NOT NULL
            AND json_extract(trigger_json, '$.context.chat.session_ref') IS NOT NULL
            THEN json_object('kind', 'chat',
              'session_id', json_extract(trigger_json, '$.context.chat.session_id'),
              'session_ref', json_extract(trigger_json, '$.context.chat.session_ref'))
          WHEN json_extract(trigger_json, '$.event_type') = 'wiki.changed'
            AND json_extract(trigger_json, '$.context.change.paths[0]') IS NOT NULL
            THEN json_object('kind', 'memory_page',
              'path', json_extract(trigger_json, '$.context.change.paths[0]'))
        END),
      'ran', NULL,
      'prompt', json_extract(skip_json, '$.event'))
    WHERE skip_json IS NOT NULL AND json_type(skip_json, '$.event') = 'text'
      AND json_valid(trigger_json)
      AND json_extract(trigger_json, '$.event_type') IN ('event_approaching', 'chat.quiet', 'wiki.changed')`)
  database.exec("ALTER TABLE scheduled_tasks DROP COLUMN prefilter")
}

export const runOnlyIfPerTrigger: Migration = {
  version: 59,
  name: "run_only_if_per_trigger",
  foreignKeys: { kind: "enforced" },
  up
}
