import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import { migrations } from "../src/persistence/migrations/index.js"
import {
  FROM_POSITIONS,
  ROW_POSITIONS,
  THROUGH_POSITIONS
} from "../src/persistence/migrations/message-removal.js"

const JOURNAL = "a journal record sequence, not a chat message"
const COMMUNICATION = "a communication clock sequence, not a chat message"
const OWN_ORDER = "the order of rows in its own table"

const NOT_MESSAGE_POSITIONS: ReadonlyArray<readonly [string, string]> = [
  ["automation_count_state.through_sequence", JOURNAL],
  ["automation_deliveries.communication_sequence", COMMUNICATION],
  ["automation_idle_state.consumed_input_sequence", JOURNAL],
  ["automation_idle_state.latest_input_sequence", JOURNAL],
  ["automation_trigger_cursor.after_sequence", JOURNAL],
  ["communication_sequence_clock.current_sequence", COMMUNICATION],
  ["home_presence.sequence", OWN_ORDER],
  ["journal_records.sequence", JOURNAL],
  ["journal_retention_cursors.sequence", JOURNAL],
  ["journal_retention_held.from_sequence", JOURNAL],
  ["journal_retention_held.through_sequence", JOURNAL],
  ["journal_streams.head_sequence", JOURNAL],
  ["journal_streams.retained_from_sequence", JOURNAL],
  ["session_event_checkpoints.checkpoint_seq", JOURNAL],
  ["space_tasks.seq", OWN_ORDER],
  ["task_proposals.seq", OWN_ORDER],
  ["transcript_search_changes.sequence", "the search index change feed"],
  ["transcript_search_clock.head_sequence", "the search index change feed"]
]

it("every column that may hold a message position is one the transcript removal moves", () => {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false })
  for (const statement of baselineStatements) database.exec(statement)
  for (const migration of migrations) migration.up(database)
  const tables = database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => String(row.name))
  const columns = tables.flatMap((table) =>
    database
      .prepare(`SELECT name FROM pragma_table_info(?)`)
      .all(table)
      .map((row) => `${table}.${String(row.name)}`)
      .filter((column) => /(^|_)seq$|sequence/.test(column.split(".")[1] ?? ""))
  )
  const known = new Set([
    ...[...THROUGH_POSITIONS, ...FROM_POSITIONS, ...ROW_POSITIONS].map(
      (position) => `${position.table}.${position.column}`
    ),
    "session_messages.seq",
    "memory_capture_unread.prepared_cut_seq",
    "session_context_hidden.seq",
    "session_turns.message_start_seq",
    "session_turns.message_end_seq",
    ...NOT_MESSAGE_POSITIONS.map(([column]) => column)
  ])
  expect(columns.filter((column) => !known.has(column)).sort()).toEqual([])
})
