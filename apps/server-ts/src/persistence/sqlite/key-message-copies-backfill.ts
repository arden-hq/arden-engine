import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { Backfill } from "./backfills/backfill.js"

const KEY_MESSAGE_COPIES_BACKFILL = "key_message_copies"

export const keyMessageCopiesBackfill: Backfill = {
  name: KEY_MESSAGE_COPIES_BACKFILL,
  landed: "2026-11-13",
  chunk: Effect.fn("KeyMessageCopies.backfillChunk")(function* ({ cursor, limit }) {
    const sql = yield* SqlClient.SqlClient
    const after = cursor === undefined ? 0 : Number(cursor)
    const window = yield* sql<{ readonly last: number | null; readonly keys: number }>`
      SELECT max(rowid) AS last, count(*) AS keys FROM (
        SELECT rowid FROM chat_idempotency_keys WHERE rowid > ${after} ORDER BY rowid LIMIT ${limit}
      )
    `
    const last = window[0]?.last ?? undefined
    if (last === undefined) return { converted: 0, next: undefined }
    const released = yield* sql<{ readonly rowid: number }>`
      UPDATE chat_idempotency_keys SET message_json = NULL
      WHERE rowid > ${after} AND rowid <= ${last} AND message_json IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM session_messages AS transcript
          WHERE transcript.session_id = chat_idempotency_keys.session_id
            AND transcript.message_id = chat_idempotency_keys.message_id
        )
      RETURNING rowid
    `
    return {
      converted: released.length,
      next: (window[0]?.keys ?? 0) < limit ? undefined : String(last)
    }
  }),
  remaining: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const state = yield* sql<{
      readonly cursor: string | null
      readonly finished_at: string | null
    }>`
      SELECT cursor, finished_at FROM data_backfills WHERE name = ${KEY_MESSAGE_COPIES_BACKFILL}
    `
    if (state[0]?.finished_at != null) return 0
    const rows = yield* sql<{ readonly top: number | null }>`
      SELECT max(rowid) AS top FROM chat_idempotency_keys
    `
    return Math.max(0, (rows[0]?.top ?? 0) - Number(state[0]?.cursor ?? 0))
  })
}
