import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

export const CONNECTION_ITEMS_TABLE = `CREATE TABLE connection_items (
      item_id TEXT PRIMARY KEY CHECK(length(item_id) > 0),
      source TEXT NOT NULL CHECK(length(source) BETWEEN 1 AND 64),
      account TEXT NOT NULL CHECK(length(account) > 0),
      external_id TEXT NOT NULL CHECK(length(external_id) > 0),
      thread_key TEXT NOT NULL CHECK(length(thread_key) > 0),
      title TEXT NOT NULL CHECK(length(title) <= 300),
      sender TEXT CHECK(sender IS NULL OR length(sender) <= 200),
      received_at TEXT NOT NULL,
      snippet TEXT NOT NULL CHECK(length(snippet) <= 300),
      fetched_at TEXT NOT NULL,
      detail TEXT CHECK(detail IS NULL OR json_valid(detail)),
      UNIQUE(source, account, external_id)
    )`

export const CONNECTION_ITEMS_THREAD_INDEX = `CREATE INDEX idx_connection_items_thread
      ON connection_items(source, account, thread_key)`

export const TASK_PROPOSALS_TABLE = `CREATE TABLE "task_proposals" (
      proposal_id TEXT PRIMARY KEY CHECK(length(proposal_id) > 0),
      place TEXT NOT NULL CHECK(place IN ('space', 'chat')),
      space_id TEXT REFERENCES spaces(space_id) ON DELETE CASCADE,
      chat_session_id TEXT REFERENCES sessions(session_id) ON DELETE CASCADE,
      dedupe_key TEXT NOT NULL UNIQUE CHECK(length(dedupe_key) > 0),
      stable_key TEXT NOT NULL CHECK(length(stable_key) > 0),
      text TEXT NOT NULL CHECK(length(trim(text)) > 0),
      body TEXT,
      owner TEXT NOT NULL CHECK(owner IN ('worker', 'user', 'external')),
      capture_json TEXT NOT NULL CHECK(json_valid(capture_json)),
      sources_json TEXT NOT NULL CHECK(json_valid(sources_json) AND json_type(sources_json) = 'array'),
      signal_json TEXT CHECK(signal_json IS NULL OR (json_valid(signal_json) AND json_type(signal_json) = 'object')),
      evidence_revision_key TEXT NOT NULL CHECK(length(evidence_revision_key) > 0),
      candidate_hash TEXT NOT NULL CHECK(length(candidate_hash) > 0),
      source_run_id TEXT CHECK(source_run_id IS NULL OR length(source_run_id) > 0),
      source_session_id TEXT REFERENCES sessions(session_id),
      source_turn_id TEXT CHECK(source_turn_id IS NULL OR length(source_turn_id) > 0),
      source_tool_call_id TEXT CHECK(source_tool_call_id IS NULL OR length(source_tool_call_id) > 0),
      capture_policy_json TEXT CHECK(capture_policy_json IS NULL OR json_valid(capture_policy_json)),
      revision INTEGER NOT NULL CHECK(revision >= 0),
      seq INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('held', 'offered', 'accepted', 'rejected', 'expired', 'retired')),
      item_id TEXT REFERENCES space_tasks(item_id) ON DELETE SET NULL,
      settlement_client_id TEXT,
      settlement_decision TEXT CHECK(settlement_decision IN ('accept', 'reject') OR settlement_decision IS NULL),
      settlement_task_json TEXT CHECK(settlement_task_json IS NULL OR json_valid(settlement_task_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      settled_at TEXT,
      retirement_json TEXT CHECK(retirement_json IS NULL OR (json_valid(retirement_json) AND json_type(retirement_json) = 'object')),
      put_off_until TEXT,
      waiting_since TEXT,
      CHECK((status = 'retired') = (retirement_json IS NOT NULL)),
      CHECK(status != 'retired' OR (settlement_client_id IS NULL AND settlement_decision IS NULL AND settled_at IS NOT NULL)),
      CHECK(status != 'expired' OR (settlement_client_id IS NULL AND settlement_decision IS NULL AND settled_at IS NOT NULL)),
      CHECK(updated_at >= created_at),
      CHECK((place = 'space') = (space_id IS NOT NULL)),
      CHECK((place = 'chat') = (chat_session_id IS NOT NULL)),
      CHECK((source_run_id IS NULL) = (source_session_id IS NULL)
        AND (source_run_id IS NULL) = (source_turn_id IS NULL)
        AND (source_run_id IS NULL) = (source_tool_call_id IS NULL)
        AND (source_run_id IS NULL) = (capture_policy_json IS NULL)),
      CHECK((status IN ('held', 'offered')) = (settlement_client_id IS NULL AND settlement_decision IS NULL AND settled_at IS NULL)),
      CHECK(status = 'accepted' OR (item_id IS NULL AND settlement_task_json IS NULL)),
      CHECK(status != 'accepted' OR settlement_decision = 'accept'),
      CHECK(status != 'rejected' OR settlement_decision = 'reject')
    )`

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

const columnsOf = (database: DatabaseSync, table: string): string =>
  database
    .prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`)
    .all()
    .map((row) => `"${String(row["name"])}"`)
    .join(", ")

const dropItemRoutes = (database: DatabaseSync): void => {
  database.exec("ALTER TABLE connection_items RENAME TO connection_items_prior")
  database.exec(CONNECTION_ITEMS_TABLE)
  const columns = columnsOf(database, "connection_items")
  database.exec(`INSERT INTO connection_items (rowid, ${columns})
    SELECT rowid, ${columns} FROM connection_items_prior`)
  database.exec("DROP TABLE connection_items_prior")
  database.exec(CONNECTION_ITEMS_THREAD_INDEX)
  database.exec("DROP TABLE connection_threads")
  database.exec(`WITH RECURSIVE gone(rule_id) AS (
      SELECT rule_id FROM permission_rules WHERE subject_kind = 'tool' AND tool_name = 'item_move'
      UNION SELECT rule.rule_id FROM permission_rules AS rule JOIN gone ON rule.from_rule_id = gone.rule_id)
    DELETE FROM permission_rules WHERE rule_id IN (SELECT rule_id FROM gone)`)
}

const retireHomeOffers = (database: DatabaseSync): void => {
  const main = database.prepare("SELECT space_id FROM spaces WHERE kind = 'main'").get()
  if (main === undefined) throw new Error("The Main Space is missing")
  const open = "status IN ('offered', 'held')"
  const settledAt = `max(${NOW}, updated_at)`
  database
    .prepare(
      `UPDATE task_proposals SET place = 'space', space_id = ?,
        status = CASE WHEN ${open} THEN 'expired' ELSE status END,
        revision = CASE WHEN ${open} THEN revision + 1 ELSE revision END,
        settled_at = CASE WHEN ${open} THEN ${settledAt} ELSE settled_at END,
        put_off_until = CASE WHEN ${open} THEN NULL ELSE put_off_until END,
        waiting_since = CASE WHEN ${open} THEN NULL ELSE waiting_since END,
        updated_at = CASE WHEN ${open} THEN ${settledAt} ELSE updated_at END
      WHERE place = 'home'`
    )
    .run(String(main.space_id))
}

const dropHomePlace = (database: DatabaseSync): void => {
  const dependents = database
    .prepare(
      `SELECT sql FROM sqlite_master WHERE tbl_name = 'task_proposals'
        AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name`
    )
    .all()
    .map((row) => String(row.sql))
  database.exec(TASK_PROPOSALS_TABLE.replace('"task_proposals"', "task_proposals_next"))
  const columns = columnsOf(database, "task_proposals")
  database.exec(
    `INSERT INTO task_proposals_next (${columns}) SELECT ${columns} FROM task_proposals`
  )
  database.exec("DROP TABLE task_proposals")
  database.exec('ALTER TABLE task_proposals_next RENAME TO "task_proposals"')
  for (const statement of dependents) database.exec(statement)
}

const up = (database: DatabaseSync): void => {
  dropItemRoutes(database)
  retireHomeOffers(database)
  dropHomePlace(database)
}

export const itemsUnrouted: Migration = {
  version: 185,
  name: "items_unrouted",
  foreignKeys: { kind: "rebuilds", tables: ["connection_items", "task_proposals"] },
  up
}
