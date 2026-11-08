import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { Backfill } from "./backfills/backfill.js"

const MESSAGE_TURN_IDS_BACKFILL = "message_turn_ids"

export const messageTurnIdSql = (sql: SqlClient.SqlClient, table: string) =>
  sql.literal(`(CASE
    WHEN EXISTS (SELECT 1 FROM message_turns AS mt WHERE mt.message_rowid = ${table}.message_rowid)
    THEN (SELECT mt.turn_id FROM message_turns AS mt WHERE mt.message_rowid = ${table}.message_rowid)
    ELSE json_extract(${table}.message_json, '$.turn_id')
  END)`)

export const messageTurnIdsBackfill: Backfill = {
  name: MESSAGE_TURN_IDS_BACKFILL,
  chunk: Effect.fn("MessageTurns.backfillChunk")(function* ({ cursor, limit }) {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly message_rowid: number }>`
      SELECT message_rowid FROM session_messages
      WHERE message_rowid > ${Number(cursor ?? 0)}
      ORDER BY message_rowid LIMIT ${limit}
    `
    const first = rows[0]
    const last = rows.at(-1)
    if (first === undefined || last === undefined) return { converted: 0, next: undefined }
    yield* sql`
      INSERT OR IGNORE INTO message_turns (message_rowid, turn_id)
      SELECT message_rowid,
        CASE WHEN json_valid(message_json) THEN json_extract(message_json, '$.turn_id') END
      FROM session_messages
      WHERE message_rowid BETWEEN ${first.message_rowid} AND ${last.message_rowid}
    `
    return {
      converted: rows.length,
      next: rows.length < limit ? undefined : String(last.message_rowid)
    }
  }),
  remaining: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly n: number }>`
      SELECT CASE
        WHEN state.finished_at IS NOT NULL THEN 0
        ELSE max(0, COALESCE((SELECT max(message_rowid) FROM session_messages), 0)
          - COALESCE(CAST(state.cursor AS INTEGER), 0))
      END AS n
      FROM (SELECT 1) LEFT JOIN data_backfills AS state
        ON state.name = ${MESSAGE_TURN_IDS_BACKFILL}
    `
    return rows[0]?.n ?? 0
  })
}
