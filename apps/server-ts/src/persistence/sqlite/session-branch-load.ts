import { Effect } from "effect"
import type { PersistenceDeps } from "./deps.js"
import { makeSessionForkOrigin } from "./session-fork.js"
import { type SessionForkOrigin } from "../sessions/fork-origin.js"
import { type SqlError } from "effect/unstable/sql/SqlError"

export type LoadBranchedSession = (sessionId: string) => Effect.Effect<
  | {
      readonly sessionId: string
      readonly name: string | undefined
      readonly startedAt: string
      readonly lastActivity: string
      readonly spaceId: string | undefined
      readonly forkOrigin: SessionForkOrigin
    }
  | undefined,
  Error | SqlError
>

export const makeBranchLoad = (sql: PersistenceDeps["writer"]["sql"]): LoadBranchedSession => {
  const loadBranchedSession = Effect.fn("SessionBranch.loadPrepared")(function* (
    sessionId: string
  ) {
    const rows = yield* sql<{
      readonly session_id: string
      readonly name: string | null
      readonly started_at: string
      readonly last_activity: string
      readonly space_id: string | null
      readonly source_session_id: string
      readonly source_session_ref: string
      readonly through_sequence: number
      readonly source_message_id: string | null
      readonly created_at: string
    }>`SELECT s.session_id, s.name, s.started_at, s.last_activity, s.space_id,
                 json_extract(s.metadata, '$.fork_origin.sourceSessionId') AS source_session_id,
                 json_extract(s.metadata, '$.fork_origin.sourceSessionRef') AS source_session_ref,
                 json_extract(s.metadata, '$.fork_origin.throughSequence') AS through_sequence,
                 json_extract(s.metadata, '$.fork_origin.sourceMessageId') AS source_message_id,
                 json_extract(s.metadata, '$.fork_origin.createdAt') AS created_at
          FROM sessions AS s WHERE s.session_id = ${sessionId}`
    const row = rows[0]
    if (row === undefined) return undefined
    const forkOrigin = yield* makeSessionForkOrigin({
      sourceSessionId: row.source_session_id,
      sourceSessionRef: row.source_session_ref,
      throughSequence: row.through_sequence,
      sourceMessageId: row.source_message_id,
      createdAt: row.created_at
    })
    return {
      sessionId: row.session_id,
      name: row.name ?? undefined,
      startedAt: row.started_at,
      lastActivity: row.last_activity,
      spaceId: row.space_id ?? undefined,
      forkOrigin
    }
  })
  return loadBranchedSession
}
