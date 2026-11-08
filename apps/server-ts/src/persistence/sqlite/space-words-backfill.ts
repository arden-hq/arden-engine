import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { spaceValue } from "../space-words-released.js"
import type { Backfill } from "./backfills/backfill.js"

const SPACE_WORDS_BACKFILL = "space_words"

/** The large history tables migration 0141 leaves for after start, with the
 * columns that hold the app's names. message_turns follows session_messages
 * through its message_turns_au trigger. */
const TABLES: ReadonlyArray<{ readonly table: string; readonly columns: ReadonlyArray<string> }> = [
  { table: "tool_calls", columns: ["tool_name", "arguments_json", "result_json"] },
  { table: "session_messages", columns: ["message_json"] },
  { table: "chat_idempotency_keys", columns: ["message_json"] },
  { table: "run_model_usage", columns: ["usage_json"] },
  { table: "journal_records", columns: ["event_type", "data_json", "attributes_json"] }
]

/** SQLite picks the rows that hold an old word, so only those reach the converter. */
const oldWordFilter = (columns: ReadonlyArray<string>): string =>
  columns
    .flatMap((column) => ["desk", "Desk", "DESK"].map((word) => `instr(${column}, '${word}') > 0`))
    .join(" OR ")

/** Cursor "<table index>:<rowid>": the last row looked at. */
const parseCursor = (
  cursor: string | undefined
): { readonly table: number; readonly rowid: number } => {
  const [table, rowid] = (cursor ?? "0:0").split(":")
  return { table: Number(table ?? 0), rowid: Number(rowid ?? 0) }
}

/** Converts the app's old "desk" names in those tables to "space", the same way
 * migration 0141 converted every other table. */
export const spaceWordsBackfill: Backfill = {
  name: SPACE_WORDS_BACKFILL,
  chunk: Effect.fn("SpaceWords.backfillChunk")(function* ({ cursor, limit }) {
    const sql = yield* SqlClient.SqlClient
    const at = parseCursor(cursor)
    const entry = TABLES[at.table]
    if (entry === undefined) return { converted: 0, next: undefined }
    const rows = yield* sql<Record<string, unknown>>`
      SELECT rowid AS row_key, ${sql.literal(entry.columns.join(", "))}
      FROM ${sql.literal(entry.table)}
      WHERE rowid > ${at.rowid} AND (${sql.literal(oldWordFilter(entry.columns))})
      ORDER BY rowid LIMIT ${limit}
    `
    let converted = 0
    for (const row of rows) {
      const changed = entry.columns.filter((column) => spaceValue(row[column]) !== row[column])
      if (changed.length === 0) continue
      converted += 1
      const assignments = changed.map(
        (column) => sql`${sql.literal(column)} = ${spaceValue(row[column]) as string}`
      )
      yield* sql`UPDATE ${sql.literal(entry.table)} SET ${sql.csv(assignments)} WHERE rowid = ${Number(row["row_key"])}`
    }
    const last = rows.at(-1)
    if (rows.length === limit && last !== undefined)
      return { converted, next: `${at.table}:${Number(last["row_key"])}` }
    return { converted, next: at.table + 1 < TABLES.length ? `${at.table + 1}:0` : undefined }
  }),
  remaining: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const state = yield* sql<{
      readonly cursor: string | null
      readonly finished_at: string | null
    }>`
      SELECT cursor, finished_at FROM data_backfills WHERE name = ${SPACE_WORDS_BACKFILL}
    `
    if (state[0]?.finished_at != null) return 0
    const at = parseCursor(state[0]?.cursor ?? undefined)
    let remaining = 0
    for (const [index, entry] of TABLES.entries()) {
      if (index < at.table) continue
      const rows = yield* sql<{ readonly top: number | null }>`
        SELECT max(rowid) AS top FROM ${sql.literal(entry.table)}
      `
      const top = rows[0]?.top ?? 0
      remaining += Math.max(0, top - (index === at.table ? at.rowid : 0))
    }
    return remaining
  })
}
