import { DateTime, Effect } from "effect"
import { SessionReadState, SessionReadStateError } from "../sessions/read-state.js"
import type { PersistenceDeps } from "./deps.js"

const error = (
  operation: "mark",
  sessionId: string,
  message: string,
  cause?: unknown
): SessionReadStateError =>
  new SessionReadStateError({
    operation,
    sessionId,
    message,
    ...(cause === undefined ? {} : { cause })
  })

export const makeSessionReadState = ({
  writer,
  sessionEvents
}: Pick<PersistenceDeps, "writer" | "sessionEvents">): SessionReadState["Service"] => {
  const sql = writer.sql
  const mark = Effect.fn("SqliteSessionReadState.mark")(function* (sessionId: string) {
    const accessedAt = DateTime.formatIso(yield* DateTime.now)
    const marked = yield* writer
      .transact(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly session_id: string }>`
        UPDATE sessions
        SET has_unread = 0, last_accessed_at = ${accessedAt}
        WHERE session_id = ${sessionId} AND archived_at IS NULL
        RETURNING session_id
      `
          if (rows.length === 0) return false
          yield* sessionEvents.appendInTransaction("session_activity", sessionId)
          return true
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof SessionReadStateError
            ? cause
            : error("mark", sessionId, "Could not mark Session read", cause)
        )
      )
    return marked ? { hasUnread: false } : null
  })

  return SessionReadState.of({ mark })
}
