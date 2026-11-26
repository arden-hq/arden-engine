import { Effect } from "effect"
import { SessionStoreError } from "../sessions/store.js"
import {
  activeSessionExternalWorkPredicate,
  activeSessionRunPredicate
} from "./session-blocking-work.js"
import type { PersistenceDeps } from "./deps.js"
import { storeError } from "./session-rows.js"

export type ContextMutation = "clear" | "revert"

export interface MutableSessionRow {
  readonly session_id: string
  readonly context_generation: number
  readonly metadata: string | null
  readonly has_active_run: number
  readonly has_active_external_work: number
  readonly has_pending_approval: number
  readonly has_compaction: number
}
export type LoadMutableSession = (
  sessionId: string | null,
  operation: ContextMutation
) => Effect.Effect<MutableSessionRow | null, SessionStoreError>

export const makeLoadMutableSession = (sql: PersistenceDeps["writer"]["sql"]): LoadMutableSession =>
  Effect.fn("SqliteSessionStore.loadMutableSession")(function* (
    sessionId: string | null,
    operation: ContextMutation
  ): Effect.fn.Return<MutableSessionRow | null, SessionStoreError> {
    const target =
      sessionId === null
        ? sql`WHERE s.archived_at IS NULL ORDER BY s.last_activity DESC, s.session_id DESC`
        : sql`WHERE s.session_id = ${sessionId}`
    const rows = yield* sql<MutableSessionRow>`
      SELECT s.session_id, s.context_generation,
             s.metadata,
             ${activeSessionRunPredicate(sql)} AS has_active_run,
             ${activeSessionExternalWorkPredicate(sql)} AS has_active_external_work,
             EXISTS (
               SELECT 1 FROM tool_approvals AS approval
               WHERE approval.session_id = s.session_id AND approval.status = 'pending'
             ) AS has_pending_approval,
             EXISTS(SELECT 1 FROM chat_compactions WHERE session_id = s.session_id) AS has_compaction
      FROM sessions AS s
      ${target}
      LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        storeError(
          operation,
          "storage",
          "Could not load the session",
          sessionId ?? undefined,
          cause
        )
      )
    )
    const row = rows[0]
    if (row === undefined) return null
    if (
      ![
        row.has_active_run,
        row.has_active_external_work,
        row.has_pending_approval,
        row.has_compaction
      ].every((value) => value === 0 || value === 1)
    ) {
      return yield* storeError(
        operation,
        "storage",
        "Session context flags are corrupt",
        row.session_id
      )
    }
    if (row.has_active_run === 1 || row.has_active_external_work === 1) {
      return yield* storeError(
        operation,
        "conflict",
        row.has_pending_approval === 1
          ? "Arden is waiting on an approval in this chat. Answer it first."
          : "Arden is still finishing work in this chat. Try again when it stops.",
        row.session_id
      )
    }
    return row
  })
