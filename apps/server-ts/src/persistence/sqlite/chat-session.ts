import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { ChatWriteError, ChatRunScheduling } from "../chat/store.js"
import { writeError, type ChatWriteOperation } from "./chat-write-errors.js"
import { sessionAncestors } from "./tree-walk.js"

export interface SessionRow {
  readonly space_id: string | null
  readonly session_id: string
  readonly active_message_count: number
  readonly metadata: string | null
  readonly chat_model: string | null
  readonly session_type: string
}

interface LiveSessionRow extends SessionRow {
  readonly origin_automation_id: string | null
}

export const loadLiveSession = Effect.fn("SqliteChatWriteStore.loadLiveSession")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string
): Effect.fn.Return<LiveSessionRow, ChatWriteError> {
  const rows = yield* sql<LiveSessionRow>`
    SELECT session_id, active_message_count, metadata, chat_model, session_type, space_id,
      origin_automation_id
    FROM sessions
    WHERE session_id = ${sessionId} AND archived_at IS NULL
    LIMIT 1
  `.pipe(
    Effect.mapError((cause) =>
      writeError("start", "storage", "Could not load live session", {
        sessionId,
        cause
      })
    )
  )
  const row = rows[0]
  return row === undefined
    ? yield* writeError("start", "not_found", "Live session was not found", { sessionId })
    : row
})

export const loadSession = Effect.fn("SqliteChatWriteStore.loadSession")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string,
  operation: ChatWriteOperation
): Effect.fn.Return<SessionRow, ChatWriteError> {
  const rows = yield* sql<SessionRow>`
    SELECT session_id, active_message_count, metadata, chat_model, session_type, space_id
    FROM sessions
    WHERE session_id = ${sessionId}
    LIMIT 1
  `.pipe(
    Effect.mapError((cause) =>
      writeError(operation, "storage", "Could not load session", {
        sessionId,
        cause
      })
    )
  )
  const row = rows[0]
  return row === undefined
    ? yield* writeError(operation, "not_found", "Session was not found", { sessionId })
    : row
})

export const schedulingForSession = Effect.fn("SqliteChatWriteStore.schedulingForSession")(
  function* (
    sql: SqlClient.SqlClient,
    sessionId: string,
    sessionType: string,
    maxConcurrentAgents: number,
    operation: ChatWriteOperation
  ): Effect.fn.Return<ChatRunScheduling, ChatWriteError> {
    if (sessionType !== "agent") return { kind: "unrestricted" }
    return {
      kind: "agent_tree",
      treeRootSessionId: yield* sessionTreeRoot(sql, sessionId, operation),
      maxConcurrentAgents
    }
  }
)

export const sessionTreeRoot = Effect.fn("SqliteChatWriteStore.sessionTreeRoot")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string,
  operation: ChatWriteOperation
): Effect.fn.Return<string, ChatWriteError> {
  const rows = yield* sql<{ readonly root_session_id: string }>`
    WITH RECURSIVE ${sessionAncestors(sql, {
      name: "lineage",
      from: sql`SELECT session_id FROM sessions WHERE session_id = ${sessionId}`,
      depth: { max: 64 }
    })}
    SELECT session_id AS root_session_id
    FROM lineage
    ORDER BY depth DESC
    LIMIT 1
  `.pipe(
    Effect.mapError((cause) =>
      writeError(operation, "storage", "Could not resolve the Session tree", {
        sessionId,
        cause
      })
    )
  )
  const root = rows[0]
  return root === undefined
    ? yield* writeError(operation, "corrupt", "Session lineage is invalid", { sessionId })
    : root.root_session_id
})
