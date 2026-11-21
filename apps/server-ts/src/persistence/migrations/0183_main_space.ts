import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

export const SPACE_KIND_COLUMN =
  "ALTER TABLE spaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'ordinary' CHECK(kind IN ('ordinary', 'main'))"

export const MAIN_SPACE_INDEX =
  "CREATE UNIQUE INDEX idx_spaces_main ON spaces(kind) WHERE kind = 'main'"

const MAIN_SPACE_ROW = `SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
        substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + abs(random()) % 4, 1) ||
        substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
      chosen.name, lower(chosen.name), 'Everything that has no Space of its own.', 'manual',
      '{"enabled":true}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'main'`

const MAIN_SPACE_COLUMNS = `space_id, name, name_key, instructions, instructions_source,
      inference_policy, created_at, updated_at, kind`

export const MAIN_SPACE_INSERT = `INSERT INTO spaces (${MAIN_SPACE_COLUMNS})
    ${MAIN_SPACE_ROW}
    FROM (SELECT 'Main' AS name) AS chosen
    WHERE NOT EXISTS (SELECT 1 FROM spaces WHERE kind = 'main')`

export const EVENT_THREADS_TABLE = `CREATE TABLE event_threads (
      source TEXT NOT NULL CHECK(length(source) BETWEEN 1 AND 64),
      account TEXT NOT NULL CHECK(length(account) > 0),
      thread_key TEXT NOT NULL CHECK(length(thread_key) > 0),
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source, account, thread_key)
    )`

export const ENTITY_EVENTS_TABLE = `CREATE TABLE entity_events (
      key TEXT PRIMARY KEY CHECK(length(key) BETWEEN 1 AND 256),
      entity TEXT NOT NULL CHECK(entity IN ('task', 'automation')),
      entity_id TEXT NOT NULL,
      event TEXT NOT NULL CHECK(event IN ('done', 'paused', 'failed', 'posted')),
      run_id TEXT,
      text TEXT NOT NULL,
      place TEXT,
      place_kind TEXT NOT NULL CHECK(place_kind IN ('own', 'chat', 'gone')),
      occurred_at TEXT NOT NULL,
      shown INTEGER NOT NULL CHECK(shown IN (0, 1)),
      delivery_error TEXT
    )`

export const ENTITY_EVENTS_RUN_INDEX =
  "CREATE INDEX idx_entity_events_run ON entity_events(run_id) WHERE run_id IS NOT NULL"

const freeMainName = (database: DatabaseSync): string => {
  const taken = new Set(
    database
      .prepare("SELECT name_key FROM spaces WHERE archived_at IS NULL")
      .all()
      .map((row) => String(row.name_key))
  )
  if (!taken.has("main")) return "Main"
  for (let index = 1; ; index += 1) {
    const name = index === 1 ? "Main space" : `Main space ${index}`
    if (!taken.has(name.toLowerCase())) return name
  }
}

const up = (database: DatabaseSync): void => {
  database.exec(SPACE_KIND_COLUMN)
  database.exec(MAIN_SPACE_INDEX)
  database
    .prepare(
      `INSERT INTO spaces (${MAIN_SPACE_COLUMNS})
      ${MAIN_SPACE_ROW}
      FROM (SELECT ? AS name) AS chosen
      WHERE NOT EXISTS (SELECT 1 FROM spaces WHERE kind = 'main')`
    )
    .run(freeMainName(database))
  database.exec(EVENT_THREADS_TABLE)
  database.exec("ALTER TABLE entity_events RENAME TO entity_events_prior")
  database.exec(ENTITY_EVENTS_TABLE)
  database.exec(`INSERT INTO entity_events SELECT key, entity, entity_id, event, run_id, text,
      place, place_kind, occurred_at, shown, delivery_error FROM entity_events_prior`)
  database.exec("DROP TABLE entity_events_prior")
  database.exec(ENTITY_EVENTS_RUN_INDEX)
}

export const mainSpace: Migration = {
  version: 183,
  name: "main_space",
  foreignKeys: { kind: "enforced" },
  up
}
