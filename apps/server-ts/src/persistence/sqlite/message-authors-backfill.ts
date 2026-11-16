import { isRecord } from "@arden-hq/std/json"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { messageAuthor } from "../transcript/model.js"
import type { Backfill } from "./backfills/backfill.js"

const MESSAGE_AUTHORS_BACKFILL = "message_authors"

const parsed = (json: string): unknown => {
  try {
    return JSON.parse(json)
  } catch {
    return undefined
  }
}

/** Stores the author of each user message migration 0166 left without one: a message its
 *  writer marked, so the mark tells. Cursor: the last message rowid looked at. */
export const messageAuthorsBackfill: Backfill = {
  name: MESSAGE_AUTHORS_BACKFILL,
  chunk: Effect.fn("MessageAuthors.backfillChunk")(function* ({ cursor, limit }) {
    const sql = yield* SqlClient.SqlClient
    const after = Number(cursor ?? 0)
    const window = yield* sql<{ readonly last: number | null; readonly rows: number }>`
      SELECT max(message_rowid) AS last, count(*) AS rows FROM (
        SELECT message_rowid FROM session_messages WHERE message_rowid > ${after}
        ORDER BY message_rowid LIMIT ${limit})`
    const last = window[0]?.last ?? undefined
    if (last === undefined) return { converted: 0, next: undefined }
    const unset = yield* sql<{ readonly message_rowid: number; readonly message_json: string }>`
      SELECT message_rowid, message_json FROM session_messages
      WHERE message_rowid > ${after} AND message_rowid <= ${last}
        AND role = 'user' AND author IS NULL`
    for (const row of unset) {
      const message = parsed(row.message_json)
      const author = (isRecord(message) ? messageAuthor(message) : null) ?? "unknown"
      yield* sql`UPDATE session_messages SET author = ${author}
        WHERE message_rowid = ${row.message_rowid}`
    }
    return {
      converted: unset.length,
      next: (window[0]?.rows ?? 0) < limit ? undefined : String(last)
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
        ON state.name = ${MESSAGE_AUTHORS_BACKFILL}`
    return rows[0]?.n ?? 0
  })
}
