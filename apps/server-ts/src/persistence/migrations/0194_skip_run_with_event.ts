import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const runWithEvent = `json(CASE
    WHEN json_type(skip_json, '$.ran.run_id') = 'integer'
      THEN json_object('kind', 'started', 'at', json_extract(skip_json, '$.ran.at'),
        'run_id', json_extract(skip_json, '$.ran.run_id'))
    WHEN json_type(skip_json, '$.ran') = 'object'
      THEN json_object('kind', 'queued', 'at', json_extract(skip_json, '$.ran.at'))
    WHEN json_type(skip_json, '$.cancelled') = 'object'
      THEN json_object('kind', 'cancelled', 'at', json_extract(skip_json, '$.cancelled.at'))
    ELSE json_object('kind', 'not_asked') END)`

const link = `json(CASE
    WHEN json_type(skip_json, '$.event.link') IS NOT 'object' THEN json_object('kind', 'none')
    WHEN json_extract(skip_json, '$.event.link.kind') IS NOT 'connection_item'
      THEN json_extract(skip_json, '$.event.link')
    WHEN json_type(skip_json, '$.event.link.url') = 'text'
      THEN json_object('kind', 'connection_item_with_page',
        'item_id', json_extract(skip_json, '$.event.link.item_id'),
        'url', json_extract(skip_json, '$.event.link.url'))
    ELSE json_object('kind', 'connection_item',
      'item_id', json_extract(skip_json, '$.event.link.item_id')) END)`

const up = (database: DatabaseSync): void => {
  database.exec(`UPDATE automation_runs
    SET skip_json = json_remove(
      json_set(skip_json, '$.run_with_event', ${runWithEvent}, '$.event.link', ${link}),
      '$.ran', '$.cancelled')
    WHERE skip_json IS NOT NULL AND json_valid(skip_json)
      AND json_extract(skip_json, '$.reason') = 'prefilter'
      AND json_type(skip_json, '$.run_with_event') IS NULL`)
}

export const skipRunWithEvent: Migration = {
  version: 194,
  name: "skip_run_with_event",
  foreignKeys: { kind: "enforced" },
  up
}
