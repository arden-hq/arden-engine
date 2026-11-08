import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const automationRuns: ReadonlyArray<string> = [
  `CREATE TABLE automation_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      automation_ref TEXT,
      origin TEXT NOT NULL DEFAULT '{"kind":"unrecorded"}' CHECK(json_valid(origin)),
      item_id TEXT,
      task_generation INTEGER,
      purpose TEXT CHECK(purpose IS NULL OR purpose IN ('user_automation', 'desk_review', 'task_execution', 'system')),
      handler TEXT,
      context_mode TEXT NOT NULL DEFAULT 'continue' CHECK(context_mode IN ('fresh', 'continue', 'fork')),
      trigger_json TEXT CHECK(trigger_json IS NULL OR json_valid(trigger_json)),
      input_json TEXT CHECK(input_json IS NULL OR json_valid(input_json)),
      claim_count INTEGER NOT NULL DEFAULT 0 CHECK(claim_count >= 0),
      disposition TEXT CHECK(disposition IS NULL OR disposition IN ('completed', 'no_change', 'needs_you', 'skipped_no_input', 'superseded', 'failed')),
      chat_run_id TEXT,
      chat_session_id TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL DEFAULT 'running'
        CHECK(status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
      result TEXT,
      error TEXT,
      CHECK((item_id IS NULL AND task_generation IS NULL) OR
        (item_id IS NOT NULL AND task_generation IS NOT NULL AND task_generation >= 0))
    )`,
  "CREATE INDEX idx_automation_runs_task ON automation_runs(task_id, started_at)",
  "CREATE INDEX idx_automation_runs_ref ON automation_runs(automation_ref, started_at)",
  "CREATE INDEX idx_automation_runs_item ON automation_runs(item_id, id DESC)",
  `CREATE INDEX idx_automation_runs_result ON automation_runs(item_id, ended_at DESC, id DESC)
      WHERE ended_at IS NOT NULL AND length(trim(result)) > 0`,
  "CREATE UNIQUE INDEX idx_automation_runs_chat_run ON automation_runs(chat_run_id) WHERE chat_run_id IS NOT NULL",
  `CREATE TRIGGER automation_runs_immutable_context
      BEFORE UPDATE OF origin, item_id, task_generation, purpose, handler, context_mode, trigger_json, input_json ON automation_runs
      WHEN NEW.origin IS NOT OLD.origin OR NEW.item_id IS NOT OLD.item_id
        OR NEW.task_generation IS NOT OLD.task_generation
        OR NEW.purpose IS NOT OLD.purpose OR NEW.handler IS NOT OLD.handler
        OR NEW.context_mode IS NOT OLD.context_mode
        OR NEW.trigger_json IS NOT OLD.trigger_json
        OR (OLD.input_json IS NOT NULL AND NEW.input_json IS NOT OLD.input_json)
      BEGIN
        SELECT RAISE(ABORT, 'Run origin and Task binding are immutable');
      END`
]

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
                AND NOT EXISTS (SELECT 1 FROM tool_calls WHERE run_id = NEW.run_id AND changes_state = 1)
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

const roleTriggers: ReadonlyArray<string> = [
  `CREATE TRIGGER session_messages_role_insert
      BEFORE INSERT ON session_messages
      WHEN NEW.role NOT IN ('system', 'developer', 'user', 'assistant', 'tool')
      BEGIN
        SELECT RAISE(ABORT, 'Unknown transcript message role');
      END`,
  `CREATE TRIGGER session_messages_role_update
      BEFORE UPDATE OF role ON session_messages
      WHEN NEW.role NOT IN ('system', 'developer', 'user', 'assistant', 'tool')
      BEGIN
        SELECT RAISE(ABORT, 'Unknown transcript message role');
      END`
]

const convertedStatus = `CASE
    WHEN prior.status = 'error' THEN 'failed'
    WHEN prior.status IN ('pending', 'backgrounded') THEN COALESCE((SELECT CASE
        WHEN chat.status IN ('pending', 'running', 'backgrounded') THEN 'running'
        WHEN chat.status IN ('completed', 'cancelled', 'interrupted') THEN chat.status
        ELSE 'failed' END
      FROM chat_runs AS chat WHERE chat.run_id = prior.chat_run_id), 'running')
    WHEN prior.status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted') THEN prior.status
    ELSE 'failed' END`

const up = (database: DatabaseSync): void => {
  database.exec("DROP TRIGGER worker_attempt_state")
  // Renaming the table must not rewrite other objects' references to it.
  database.exec("PRAGMA legacy_alter_table = ON")
  try {
    rebuild(database, "automation_runs", automationRuns, { status: convertedStatus })
  } finally {
    database.exec("PRAGMA legacy_alter_table = OFF")
  }
  database.exec(workerAttemptState)
  for (const statement of roleTriggers) database.exec(statement)
}

const rebuild = (
  database: DatabaseSync,
  table: string,
  statements: ReadonlyArray<string>,
  converted: Readonly<Record<string, string>>
): void => {
  const [create, ...dependents] = statements
  if (create === undefined) throw new Error(`${table} has no creation SQL`)
  const prior = `${table}_prior`
  database.exec(`ALTER TABLE ${table} RENAME TO ${prior}`)
  database.exec(create)
  const columns = database
    .prepare(`PRAGMA table_info(${prior})`)
    .all()
    .map((column) => String(column.name))
  const values = columns.map((column) => converted[column] ?? `prior.${column}`)
  database.exec(`INSERT INTO ${table} (rowid, ${columns.join(", ")})
    SELECT prior.rowid, ${values.join(", ")} FROM ${prior} AS prior`)
  // AUTOINCREMENT: the old counter carries over, so an id a deleted row once
  database.exec(`DELETE FROM sqlite_sequence WHERE name = '${table}'`)
  database.exec(`UPDATE sqlite_sequence SET name = '${table}' WHERE name = '${prior}'`)
  database.exec(`DROP TABLE ${prior}`)
  for (const statement of dependents) database.exec(statement)
}

export const closedValueChecks: Migration = {
  version: 2,
  name: "closed_value_checks",
  up
}
