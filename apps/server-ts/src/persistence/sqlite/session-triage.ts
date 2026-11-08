import { Effect, Schema } from "effect"
import type { SessionStore } from "../sessions/store.js"
import { SessionStoreError } from "../sessions/store.js"
import { StoredTriageSchema, type StoredTriage } from "../sessions/triage.js"
import type { PersistenceDeps } from "./deps.js"
import { encodeJsonWith } from "./json.js"
import { sessionIdSchema, storeError } from "./session-rows.js"

export const makeSessionTriageRecords = ({
  writer
}: Pick<PersistenceDeps, "writer">): Pick<
  SessionStore["Service"],
  "saveTriage" | "adoptSpaceConversation" | "releaseSpaceConversation"
> => {
  const sql = writer.sql
  const failure = (sessionId: string, message: string) => (cause: unknown) =>
    cause instanceof SessionStoreError
      ? cause
      : storeError("triage", "storage", message, sessionId, cause)

  const saveTriage = Effect.fn("SqliteSessionStore.saveTriage")(function* (
    sessionId: string,
    triage: StoredTriage
  ): Effect.fn.Return<boolean, SessionStoreError> {
    const validSessionId = yield* Schema.decodeUnknownEffect(sessionIdSchema)(sessionId).pipe(
      Effect.mapError((cause) =>
        storeError("triage", "invalid", "Session id must not be empty", sessionId, cause)
      )
    )
    const text = yield* encodeJsonWith(StoredTriageSchema, triage, (cause) =>
      storeError("triage", "invalid", "Triage decision cannot be stored", validSessionId, cause)
    )
    const updated = yield* writer
      .transact(
        sql<{ readonly session_id: string }>`
      UPDATE sessions SET metadata = json_set(COALESCE(metadata, '{}'), '$.triage', json(${text}))
      WHERE session_id = ${validSessionId} AND archived_at IS NULL
      RETURNING session_id
    `
      )
      .pipe(Effect.mapError(failure(validSessionId, "Could not store the triage decision")))
    return updated.length > 0
  })

  const adoptSpaceConversation = Effect.fn("SqliteSessionStore.adoptSpaceConversation")(function* (
    spaceId: string,
    sessionId: string
  ): Effect.fn.Return<void, SessionStoreError> {
    yield* writer
      .transact(
        Effect.gen(function* () {
          const existing = yield* sql<{ readonly session_id: string }>`
        SELECT session_id FROM space_conversations WHERE space_id = ${spaceId}
      `
          if (existing.length > 0) {
            return yield* storeError(
              "triage",
              "conflict",
              "This Space already has its conversation",
              sessionId
            )
          }
          yield* sql`INSERT INTO space_conversations (space_id, session_id) VALUES (${spaceId}, ${sessionId})`
        })
      )
      .pipe(
        Effect.mapError(failure(sessionId, "Could not make this Chat the Space's conversation"))
      )
  })

  const releaseSpaceConversation = Effect.fn("SqliteSessionStore.releaseSpaceConversation")(
    function* (spaceId: string, sessionId: string): Effect.fn.Return<void, SessionStoreError> {
      yield* writer
        .transact(
          sql`
      DELETE FROM space_conversations WHERE space_id = ${spaceId} AND session_id = ${sessionId}
    `
        )
        .pipe(Effect.mapError(failure(sessionId, "Could not release the Space's conversation")))
    }
  )

  return { saveTriage, adoptSpaceConversation, releaseSpaceConversation }
}
