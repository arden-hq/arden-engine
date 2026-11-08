import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(`CREATE TABLE run_endings (
      run_id TEXT PRIMARY KEY REFERENCES chat_runs(run_id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK(purpose IN ('chat', 'user_automation', 'system', 'task_execution', 'desk_review')),
      status TEXT NOT NULL CHECK(status IN ('finished', 'blocked', 'failed', 'cancelled', 'silent', 'waiting')),
      detail TEXT,
      text TEXT NOT NULL,
      place TEXT,
      place_kind TEXT NOT NULL CHECK(place_kind IN ('own', 'chat', 'parent', 'sender', 'gone')),
      occurred_at TEXT NOT NULL,
      shown INTEGER NOT NULL CHECK(shown IN (0, 1)),
      decided INTEGER NOT NULL CHECK(decided IN (0, 1)),
      delivery_error TEXT
    )`)
  database.exec(`CREATE TABLE entity_events (
      key TEXT PRIMARY KEY CHECK(length(key) BETWEEN 1 AND 256),
      entity TEXT NOT NULL CHECK(entity IN ('task', 'automation')),
      entity_id TEXT NOT NULL,
      event TEXT NOT NULL CHECK(event IN ('done', 'paused', 'failed')),
      run_id TEXT,
      text TEXT NOT NULL,
      place TEXT,
      place_kind TEXT NOT NULL CHECK(place_kind IN ('own', 'chat', 'gone')),
      occurred_at TEXT NOT NULL,
      shown INTEGER NOT NULL CHECK(shown IN (0, 1)),
      delivery_error TEXT
    )`)
  database.exec(
    `CREATE INDEX idx_entity_events_run ON entity_events(run_id) WHERE run_id IS NOT NULL`
  )
  database.exec(`CREATE INDEX idx_run_endings_undecided ON run_endings(run_id) WHERE decided = 0`)
  database.exec(`CREATE INDEX idx_automation_deliveries_answer
      ON automation_deliveries(destinations) WHERE json_extract(payload, '$.kind') = 'answer'`)
}

export const runEndings: Migration = {
  version: 76,
  name: "run_endings",
  foreignKeys: { kind: "enforced" },
  up
}
