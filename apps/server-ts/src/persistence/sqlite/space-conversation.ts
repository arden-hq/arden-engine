import { DateTime, Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import { SessionStoreError, type SessionStore } from "../sessions/store.js"
import type { Writer } from "./deps.js"
import { nextId } from "./deps.js"
import { friendlySessionRef } from "../public-ref.js"
import { insertSession } from "./session-insert.js"

export const makeEnsureSpaceConversation = ({
  writer,
  sessionEvents
}: {
  readonly writer: Writer
  readonly sessionEvents: SessionLifecycleEvents["Service"]
}): SessionStore["Service"]["ensureSpaceConversation"] =>
  Effect.fn("SpaceConversation.ensure")(
    function* (spaceId: string) {
      const sql = writer.sql
      return yield* writer.transact(
        Effect.gen(function* () {
          const spaces = yield* sql<{ readonly name: string }>`
        SELECT name FROM spaces WHERE space_id = ${spaceId} AND archived_at IS NULL
      `
          const space = spaces[0]
          if (space === undefined) {
            return yield* new SessionStoreError({
              operation: "create",
              reason: "not_found",
              message: "Space not found"
            })
          }
          const existing = yield* sql<{ readonly session_id: string }>`
        SELECT session_id FROM space_conversations WHERE space_id = ${spaceId}
      `
          if (existing[0] !== undefined) return existing[0].session_id
          const sessionId = yield* nextId
          const timestamp = DateTime.formatIso(yield* DateTime.now)
          yield* insertSession({
            sql,
            session: {
              type: "chat",
              sessionId,
              publicRef: friendlySessionRef(sessionId),
              startedAt: timestamp,
              name: space.name,
              metadata: "{}",
              spaceId,
              chatModel: null,
              originAutomationId: null,
              parent: null
            },
            lifecycle: {
              kind: "announce",
              events: sessionEvents,
              complete: sql`INSERT INTO space_conversations (space_id, session_id)
            VALUES (${spaceId}, ${sessionId})`
            }
          })
          return sessionId
        })
      )
    },
    Effect.mapError((cause) =>
      cause instanceof SessionStoreError
        ? cause
        : new SessionStoreError({
            operation: "create",
            reason: "storage",
            message: "Could not create the Space conversation",
            cause
          })
    )
  )

export const assertIndependentConversation = Effect.fn("SpaceConversation.assertIndependent")(
  function* ({
    sql,
    sessionId,
    operation
  }: {
    readonly sql: SqlClient.SqlClient
    readonly sessionId: string
    readonly operation: "move" | "archive"
  }) {
    const binding =
      yield* sql`SELECT space_id FROM space_conversations WHERE session_id = ${sessionId}`
    if (binding.length > 0) {
      return yield* new SessionStoreError({
        operation,
        reason: "conflict",
        sessionId,
        message: "The Space conversation stays with its Space; manage the Space instead"
      })
    }
  }
)
