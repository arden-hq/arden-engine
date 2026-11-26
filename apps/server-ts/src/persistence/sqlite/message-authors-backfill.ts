import { ROLE } from "@arden-hq/std/message-vocabulary"
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

/**
 * Stores the author of each user message that has none: every message saved before the column
 * existed. A writer's mark tells the author. An unmarked turn or answer is the owner's only with
 * proof: a chat-started run of the turn or a resolved question, in the chat or a chat it was
 * copied from. With no proof kept it is `unknown`. Cursor: the last message rowid looked at.
 */
export const messageAuthorsBackfill: Backfill = {
  name: MESSAGE_AUTHORS_BACKFILL,
  landed: "2026-11-16",
  chunk: Effect.fn("MessageAuthors.backfillChunk")(function* ({ cursor, limit }) {
    const sql = yield* SqlClient.SqlClient
    const after = Number(cursor ?? 0)
    const window = yield* sql<{
      readonly last: number | null
      readonly rows: number
    }>`
      SELECT max(message_rowid) AS last, count(*) AS rows FROM (
        SELECT message_rowid FROM session_messages WHERE message_rowid > ${after}
        ORDER BY message_rowid LIMIT ${limit})`
    const last = window[0]?.last ?? undefined
    if (last === undefined) return { converted: 0, next: undefined }
    const unset = yield* sql<{
      readonly message_rowid: number
      readonly session_id: string
      readonly message_id: string
      readonly message_json: string
    }>`
      SELECT message_rowid, session_id, message_id, message_json FROM session_messages
      WHERE message_rowid > ${after} AND message_rowid <= ${last}
        AND role = ${ROLE.user} AND author IS NULL`
    const proofs = new Map<string, ReadonlySet<string>>()
    for (const row of unset) {
      const message = parsed(row.message_json)
      const marked = (isRecord(message) ? messageAuthor(message) : null) ?? "unknown"
      let author = marked
      if (isRecord(message) && (marked === "owner" || marked === "answer")) {
        const known = proofs.get(row.session_id) ?? (yield* ownerProofs(sql, row.session_id))
        proofs.set(row.session_id, known)
        if (!known.has(proofKey(marked, message, row.message_id))) author = "unknown"
      }
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

const proofKey = (
  author: "owner" | "answer",
  message: Readonly<Record<string, unknown>>,
  messageId: string
): string => {
  if (author === "owner")
    return `turn:${typeof message.turn_id === "string" ? message.turn_id : messageId}`
  const answer = message.question_answer
  return `question:${isRecord(answer) && typeof answer.question_id === "string" ? answer.question_id : ""}`
}

/** The turns a chat started and the questions it resolved, in `sessionId` and its sources. */
const ownerProofs = Effect.fn("MessageAuthors.ownerProofs")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string
) {
  const rows = yield* sql<{ readonly proof: string }>`
    WITH RECURSIVE chats(chat) AS (
      SELECT ${sessionId}
      UNION SELECT json_extract(branch.metadata, '$.fork_origin.sourceSessionId')
      FROM chats JOIN sessions AS branch ON branch.session_id = chats.chat)
    SELECT 'turn:' || json_extract(run.metadata_json, '$.turn_id') AS proof
    FROM chats JOIN chat_runs AS run ON run.session_id = chats.chat
    WHERE json_extract(run.metadata_json, '$.run_context.origin.kind') = 'chat'
      AND json_extract(run.metadata_json, '$.turn_id') IS NOT NULL
    UNION SELECT 'question:' || question.question_id
    FROM chats JOIN chat_runs AS run ON run.session_id = chats.chat
    JOIN run_questions AS question ON question.run_id = run.run_id
    WHERE question.resolution IS NOT NULL`
  return new Set(rows.map((row) => row.proof))
})
