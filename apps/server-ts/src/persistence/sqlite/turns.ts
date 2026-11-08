import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { messageTurnIdSql } from "./message-turns.js"

export const currentSessionTurnId = Effect.fn("Sqlite.currentSessionTurnId")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string
) {
  const rows = yield* sql<{ readonly turn_id: string | null }>`
    SELECT ${messageTurnIdSql(sql, "session_messages")} AS turn_id
    FROM session_messages
    WHERE session_id = ${sessionId}
    ORDER BY seq DESC
    LIMIT 1
  `
  return rows[0]?.turn_id ?? null
})

export const appendSessionTurn = Effect.fn("Sqlite.appendSessionTurn")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly sessionId: string
    readonly turnId: string
    readonly firstSequence: number
    readonly messages: ReadonlyArray<{ readonly message_id: string; readonly created_at: string }>
  }
) {
  const first = input.messages[0]
  const last = input.messages.at(-1)
  if (first === undefined || last === undefined) return
  let startedAt = first.created_at
  let endedAt = first.created_at
  for (const message of input.messages) {
    if (message.created_at < startedAt) startedAt = message.created_at
    if (message.created_at > endedAt) endedAt = message.created_at
  }
  const lastSequence = input.firstSequence + input.messages.length - 1
  yield* sql`
    INSERT INTO session_turns (
      session_id, turn_id, turn_index, user_message_id,
      message_start_id, message_end_id, message_start_seq, message_end_seq,
      started_at, ended_at
    ) VALUES (
      ${input.sessionId}, ${input.turnId},
      (SELECT COALESCE(MAX(turn_index) + 1, 0) FROM session_turns WHERE session_id = ${input.sessionId}),
      ${input.turnId}, ${first.message_id}, ${last.message_id},
      ${input.firstSequence}, ${lastSequence}, ${startedAt}, ${endedAt}
    )
    ON CONFLICT(session_id, turn_id) DO UPDATE SET
      message_end_id = excluded.message_end_id,
      message_end_seq = excluded.message_end_seq,
      started_at = MIN(session_turns.started_at, excluded.started_at),
      ended_at = MAX(session_turns.ended_at, excluded.ended_at)
  `
})

export const rebuildSessionTurns = Effect.fn("Sqlite.rebuildSessionTurns")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string,
  { fromSeq = 0 }: { readonly fromSeq?: number } = {}
) {
  const affected = yield* sql<{ readonly start_seq: number | null }>`
    SELECT MIN(message_start_seq) AS start_seq FROM session_turns
    WHERE session_id = ${sessionId} AND message_end_seq >= ${fromSeq}
  `
  const scanFrom = Math.min(fromSeq, affected[0]?.start_seq ?? fromSeq)
  yield* sql`DELETE FROM session_turns WHERE session_id = ${sessionId} AND message_end_seq >= ${fromSeq}`
  yield* sql`
    WITH turns AS (
      SELECT ${messageTurnIdSql(sql, "session_messages")} AS turn_id,
             MIN(seq) AS start_seq,
             MAX(seq) AS end_seq,
             MIN(created_at) AS started_at,
             MAX(created_at) AS ended_at,
             ROW_NUMBER() OVER (ORDER BY MIN(seq)) - 1 AS turn_rank
      FROM session_messages
      WHERE session_id = ${sessionId}
        AND seq >= ${scanFrom}
        AND ${messageTurnIdSql(sql, "session_messages")} IS NOT NULL
        AND ${messageTurnIdSql(sql, "session_messages")} NOT IN (
          SELECT turn_id FROM session_turns WHERE session_id = ${sessionId}
        )
      GROUP BY ${messageTurnIdSql(sql, "session_messages")}
    ),
    base AS (
      SELECT COALESCE(MAX(turn_index) + 1, 0) AS next_index
      FROM session_turns WHERE session_id = ${sessionId}
    )
    INSERT INTO session_turns (
      session_id, turn_id, turn_index, user_message_id,
      message_start_id, message_end_id, message_start_seq, message_end_seq,
      started_at, ended_at
    )
    SELECT ${sessionId}, turns.turn_id, base.next_index + turns.turn_rank, turns.turn_id,
           starting.message_id, ending.message_id, turns.start_seq, turns.end_seq,
           turns.started_at, turns.ended_at
    FROM turns
    CROSS JOIN base
    JOIN session_messages AS starting
      ON starting.session_id = ${sessionId} AND starting.seq = turns.start_seq
    JOIN session_messages AS ending
      ON ending.session_id = ${sessionId} AND ending.seq = turns.end_seq
    ORDER BY turns.turn_rank
  `
})
