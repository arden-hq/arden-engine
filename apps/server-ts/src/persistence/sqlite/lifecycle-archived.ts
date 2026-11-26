import { journalHeadSequenceSql, type JournalAppendResult } from "@arden-hq/journal/effect"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { SESSION_LIFECYCLE_STREAM_ID, SessionLifecycleEventError } from "../sessions/events.js"

export const lifecycleError = (
  operation: SessionLifecycleEventError["operation"],
  message: string,
  cause?: unknown
): SessionLifecycleEventError =>
  new SessionLifecycleEventError({
    operation,
    message,
    ...(cause === undefined ? {} : { cause })
  })

export const archivedChatAppend = Effect.fn("SessionLifecycleEvents.archivedChatAppend")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string
) {
  const rows = yield* sql<{ readonly head: number | null }>`
      SELECT ${journalHeadSequenceSql(sql, SESSION_LIFECYCLE_STREAM_ID)} AS head
      FROM sessions WHERE session_id = ${sessionId} AND archived_at IS NOT NULL
    `.pipe(
    Effect.mapError((cause) =>
      lifecycleError("append", "Could not read the Session archive state", cause)
    )
  )
  const row = rows[0]
  if (row === undefined) return null
  return { records: [], headSequence: row.head ?? 0 } satisfies JournalAppendResult
})
