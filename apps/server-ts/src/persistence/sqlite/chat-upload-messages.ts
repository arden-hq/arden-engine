import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { Backfill } from "./backfills/backfill.js"

export const CHAT_UPLOAD_MESSAGES_BACKFILL = "chat_upload_messages"

export const chatUploadMessagesBackfill: Backfill = {
  name: CHAT_UPLOAD_MESSAGES_BACKFILL,
  chunk: Effect.fn("ChatUploadMessages.backfillChunk")(function* ({ cursor, limit }) {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly message_rowid: number; readonly names: number }>`
      SELECT message_rowid, (role = 'user' AND instr(message_json, '/uploads/') > 0) AS names
      FROM session_messages
      WHERE message_rowid > ${Number(cursor ?? 0)}
      ORDER BY message_rowid LIMIT ${limit}
    `
    let converted = 0
    for (const row of rows) {
      if (row.names !== 1) continue
      yield* sql`INSERT OR IGNORE INTO chat_upload_messages (message_rowid)
        VALUES (${row.message_rowid})`
      converted += 1
    }
    const last = rows.at(-1)
    return {
      converted,
      next: rows.length < limit || last === undefined ? undefined : String(last.message_rowid)
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
        ON state.name = ${CHAT_UPLOAD_MESSAGES_BACKFILL}
    `
    return rows[0]?.n ?? 0
  })
}
