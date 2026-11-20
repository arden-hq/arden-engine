import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { uploadIdsIn } from "../sessions/chat-uploads.js"
import type { Backfill } from "./backfills/backfill.js"

export const CHAT_UPLOAD_MESSAGES_BACKFILL = "chat_upload_messages"

export const chatUploadMessagesBackfill: Backfill = {
  name: CHAT_UPLOAD_MESSAGES_BACKFILL,
  chunk: Effect.fn("ChatUploadMessages.backfillChunk")(function* ({ cursor, limit }) {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly message_rowid: number; readonly names: number }>`
      SELECT message_rowid,
        (role IN ('user', 'interaction') AND instr(message_json, '/uploads/') > 0) AS names
      FROM session_messages
      WHERE message_rowid > ${Number(cursor ?? 0)}
      ORDER BY message_rowid LIMIT ${limit}
    `
    let converted = 0
    for (const row of rows) {
      if (row.names !== 1) continue
      yield* sql`INSERT OR IGNORE INTO chat_upload_unlisted (message_rowid)
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

const UNLISTED_CHUNK = 64

/**
 * Reads up to one chunk of the messages the triggers noted in
 * `chat_upload_unlisted` and writes the upload folders each one names to
 * `chat_upload_refs`. Returns whether more are waiting. Run it to the end, in
 * the same transaction as the question, before asking who names an upload.
 */
export const listUploadRefsChunk = Effect.fn("ChatUploadRefs.listChunk")(function* (
  sql: SqlClient.SqlClient
) {
  const noted = yield* sql<{ readonly message_rowid: number }>`
    SELECT message_rowid FROM chat_upload_unlisted ORDER BY message_rowid LIMIT ${UNLISTED_CHUNK}`
  if (noted.length === 0) return false
  const ids = noted.map((row) => row.message_rowid)
  const messages = yield* sql<{
    readonly message_rowid: number
    readonly role: string
    readonly message_json: string
  }>`SELECT message_rowid, role, message_json FROM session_messages
    WHERE message_rowid IN ${sql.in(ids)}`
  yield* sql`DELETE FROM chat_upload_refs WHERE message_rowid IN ${sql.in(ids)}`
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "interaction") continue
    for (const uploadId of uploadIdsIn(message.message_json)) {
      yield* sql`INSERT OR IGNORE INTO chat_upload_refs (upload_id, message_rowid)
        VALUES (${uploadId}, ${message.message_rowid})`
    }
  }
  yield* sql`DELETE FROM chat_upload_unlisted WHERE message_rowid IN ${sql.in(ids)}`
  return noted.length === UNLISTED_CHUNK
})
