import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

export const SPACE_JOB_KEYS_TABLE = `CREATE TABLE space_job_keys (
      automation_id TEXT PRIMARY KEY CHECK(length(automation_id) > 0),
      purpose TEXT NOT NULL CHECK(purpose IN ('space_review', 'task_execution')),
      space_id TEXT,
      item_id TEXT,
      CHECK((purpose = 'space_review') = (space_id IS NOT NULL)),
      CHECK((purpose = 'task_execution') = (item_id IS NOT NULL))
    )`

export const SPACE_JOB_KEY_TRIGGER = `CREATE TRIGGER spaces_job_key AFTER INSERT ON spaces
      BEGIN
        INSERT OR IGNORE INTO space_job_keys (automation_id, purpose, space_id)
        VALUES ('space:' || NEW.space_id, 'space_review', NEW.space_id);
      END`

export const TASK_JOB_KEY_TRIGGER = `CREATE TRIGGER space_tasks_job_key AFTER INSERT ON space_tasks
      BEGIN
        INSERT OR IGNORE INTO space_job_keys (automation_id, purpose, item_id)
        VALUES ('task:' || NEW.item_id, 'task_execution', NEW.item_id);
      END`

const SPACE_PREFIX = "space:"
const TASK_PREFIX = "task:"

const knownKeys = (database: DatabaseSync): ReadonlyArray<string> =>
  database
    .prepare(
      `SELECT task_id AS automation_id FROM automation_event_queue
       UNION SELECT task_id FROM automation_runs WHERE task_id IS NOT NULL
       UNION SELECT origin_automation_id FROM sessions WHERE origin_automation_id IS NOT NULL
       UNION SELECT json_extract(metadata_json, '$.run_policy.automation_id') FROM chat_runs
         WHERE json_valid(metadata_json) AND json_type(metadata_json, '$.run_policy.automation_id') = 'text'
       UNION SELECT json_extract(metadata_json, '$.automation.task_id') FROM chat_runs
         WHERE json_valid(metadata_json) AND json_type(metadata_json, '$.automation.task_id') = 'text'`
    )
    .all()
    .flatMap((row) => (typeof row.automation_id === "string" ? [row.automation_id] : []))

const up = (database: DatabaseSync): void => {
  database.exec(SPACE_JOB_KEYS_TABLE)
  database.exec(`INSERT INTO space_job_keys (automation_id, purpose, space_id)
    SELECT 'space:' || space_id, 'space_review', space_id FROM spaces`)
  database.exec(`INSERT INTO space_job_keys (automation_id, purpose, item_id)
    SELECT 'task:' || item_id, 'task_execution', item_id FROM space_tasks`)
  const review = database.prepare(
    "INSERT OR IGNORE INTO space_job_keys (automation_id, purpose, space_id) VALUES (?, 'space_review', ?)"
  )
  const task = database.prepare(
    "INSERT OR IGNORE INTO space_job_keys (automation_id, purpose, item_id) VALUES (?, 'task_execution', ?)"
  )
  for (const key of knownKeys(database)) {
    if (key.startsWith(SPACE_PREFIX) && key.length > SPACE_PREFIX.length)
      review.run(key, key.slice(SPACE_PREFIX.length))
    else if (key.startsWith(TASK_PREFIX) && key.length > TASK_PREFIX.length)
      task.run(key, key.slice(TASK_PREFIX.length))
  }
  database.exec(SPACE_JOB_KEY_TRIGGER)
  database.exec(TASK_JOB_KEY_TRIGGER)
}

export const spaceJobKeys: Migration = {
  version: 190,
  name: "space_job_keys",
  foreignKeys: { kind: "enforced" },
  up
}
