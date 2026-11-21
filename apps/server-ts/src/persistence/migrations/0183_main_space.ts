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
      delivery_id TEXT NOT NULL,
      last_delivery_id TEXT NOT NULL,
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
      .prepare("SELECT name_key FROM spaces")
      .all()
      .map((row) => String(row.name_key))
  )
  if (!taken.has("main")) return "Main"
  for (let index = 1; ; index += 1) {
    const name = index === 1 ? "Main space" : `Main space ${index}`
    if (!taken.has(name.toLowerCase())) return name
  }
}

const TASK_KEY_MAX = 80

const suffixed = (base: string, index: number): string => {
  const suffix = `-${index}`
  return `${base.slice(0, TASK_KEY_MAX - suffix.length)}${suffix}`
}

const moveOwnerChats = (database: DatabaseSync, mainId: string): void => {
  database
    .prepare(
      "UPDATE sessions SET space_id = ? WHERE space_id IS NULL AND origin_automation_id IS NULL"
    )
    .run(mainId)
  database
    .prepare(
      `UPDATE sessions SET space_id = ?
      WHERE space_id IS NULL AND origin_automation_id IS NOT NULL AND session_type = 'chat'
        AND parent_session_id IS NOT NULL
        AND CASE WHEN json_valid(metadata) THEN COALESCE(
          json_extract(metadata, '$.fork_origin.sourceSessionId'),
          json_extract(metadata, '$.fork_of.source_session_id')) END
          IN (SELECT session_id FROM sessions WHERE space_id = ?)`
    )
    .run(mainId, mainId)
  database
    .prepare(
      `WITH RECURSIVE moved(session_id) AS (
        SELECT session_id FROM sessions WHERE space_id = ?
        UNION
        SELECT child.session_id FROM sessions AS child
        JOIN moved ON child.parent_session_id = moved.session_id
        WHERE child.space_id IS NULL)
      UPDATE sessions SET space_id = ?
      WHERE space_id IS NULL AND session_id IN (SELECT session_id FROM moved)`
    )
    .run(mainId, mainId)
  database
    .prepare(
      `UPDATE sessions SET metadata = json_remove(metadata, '$.fork_resources')
      WHERE space_id = ?
        AND CASE WHEN json_valid(metadata) THEN json_type(metadata, '$.fork_resources') END
          IS NOT NULL
        AND EXISTS (SELECT 1 FROM sessions AS source
          WHERE source.session_id = json_extract(sessions.metadata, '$.fork_resources.source_session_id')
            AND source.space_id IS NULL)`
    )
    .run(mainId)
  const moving = `space_id IS NULL
    AND home_session_id IN (SELECT session_id FROM sessions WHERE space_id = ?)`
  const tasks = database
    .prepare(
      `SELECT item_id, stable_key FROM space_tasks WHERE ${moving} ORDER BY created_at, item_id`
    )
    .all(mainId)
  const taken = new Set(tasks.map((task) => String(task.stable_key)))
  const kept = new Set<string>()
  const nextIndex = new Map<string, number>()
  const rekey = database.prepare("UPDATE space_tasks SET stable_key = ? WHERE item_id = ?")
  for (const task of tasks) {
    const base = String(task.stable_key)
    if (!kept.has(base)) {
      kept.add(base)
      continue
    }
    let index = nextIndex.get(base) ?? 2
    let candidate = suffixed(base, index)
    while (taken.has(candidate)) {
      index += 1
      candidate = suffixed(base, index)
    }
    taken.add(candidate)
    nextIndex.set(base, index + 1)
    rekey.run(candidate, String(task.item_id))
  }
  database.prepare(`UPDATE space_tasks SET space_id = ? WHERE ${moving}`).run(mainId, mainId)
  for (const table of ["space_task_events", "space_task_comments", "space_task_attachments"])
    database
      .prepare(
        `UPDATE ${table} SET space_id = ?
        WHERE space_id IS NULL AND item_id IN (SELECT item_id FROM space_tasks WHERE space_id = ?)`
      )
      .run(mainId, mainId)
  database
    .prepare(
      `UPDATE sessions SET space_id = ?
      WHERE space_id IS NULL AND origin_automation_id IN
        (SELECT 'task:' || item_id FROM space_tasks WHERE space_id = ?)`
    )
    .run(mainId, mainId)
}

const RUN_CONTEXT_GUARD = `CREATE TRIGGER chat_runs_immutable_context
      BEFORE UPDATE OF metadata_json ON chat_runs
      WHEN (json_extract(OLD.metadata_json, '$.run_context') IS NOT NULL
        AND (json_remove(json_extract(NEW.metadata_json, '$.run_context'), '$.belongs_to')
            IS NOT json_remove(json_extract(OLD.metadata_json, '$.run_context'), '$.belongs_to')
          OR (json_type(OLD.metadata_json, '$.run_context.belongs_to') IS NOT NULL
            AND json_extract(NEW.metadata_json, '$.run_context.belongs_to')
              IS NOT json_extract(OLD.metadata_json, '$.run_context.belongs_to'))))
        OR (json_extract(OLD.metadata_json, '$.run_policy') IS NOT NULL
        AND json_extract(NEW.metadata_json, '$.run_policy') IS NOT json_extract(OLD.metadata_json, '$.run_policy'))
      BEGIN
        SELECT RAISE(ABORT, 'Run origin and Task binding are immutable');
      END`

const RUN_AUTHORITY_GUARD = `CREATE TRIGGER chat_runs_immutable_authority
      BEFORE UPDATE OF authority_json ON chat_runs
      WHEN OLD.authority_json IS NOT NULL AND NEW.authority_json IS NOT OLD.authority_json
      BEGIN
        SELECT RAISE(ABORT, 'Run authority is immutable');
      END`

const moveRunAuthority = (database: DatabaseSync, mainId: string): void => {
  database.exec("DROP TRIGGER chat_runs_immutable_context")
  database.exec("DROP TRIGGER chat_runs_immutable_authority")
  database
    .prepare(
      `UPDATE chat_runs SET
        metadata_json = json_set(metadata_json, '$.run_policy.space', json_object(
          'space_id', main.space_id, 'generation', main.policy_generation,
          'inference', json(main.inference_policy))),
        authority_json = CASE
          WHEN authority_json IS NULL THEN NULL
          WHEN json_extract(authority_json, '$.actor.kind') = 'task_worker' THEN json_set(
            authority_json, '$.owns.space_id', main.space_id, '$.actor.space_id', main.space_id,
            '$.memory', json_object('_tag', 'Space', 'space_id', main.space_id))
          ELSE json_set(authority_json, '$.owns.space_id', main.space_id) END
      FROM (SELECT space_id, policy_generation, inference_policy FROM spaces WHERE space_id = ?) AS main
      WHERE json_type(chat_runs.metadata_json, '$.run_policy.space') = 'null'
        AND json_extract(chat_runs.metadata_json, '$.run_policy.authority_session_id') IN
          (SELECT session_id FROM sessions WHERE space_id = ?)`
    )
    .run(mainId, mainId)
  database.exec(RUN_CONTEXT_GUARD)
  database.exec(RUN_AUTHORITY_GUARD)
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
  const main = database.prepare("SELECT space_id FROM spaces WHERE kind = 'main'").get()
  if (main === undefined) throw new Error("The Main Space was not created")
  moveOwnerChats(database, String(main.space_id))
  moveRunAuthority(database, String(main.space_id))
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
