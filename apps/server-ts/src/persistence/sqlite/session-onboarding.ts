import { DateTime, Effect } from "effect"
import { onboardingClientId, SessionStoreError, type SessionStore } from "../sessions/store.js"
import { mainSpaceIdSql } from "./main-space.js"
import type { PersistenceDeps } from "./deps.js"
import { storeError } from "./session-rows.js"

export const makeSessionOnboarding = ({
  writer
}: Pick<PersistenceDeps, "writer">): Pick<
  SessionStore["Service"],
  "startOnboarding" | "finishOnboarding"
> => ({
  startOnboarding: Effect.fn("SqliteSessionStore.startOnboarding")(function* (sessionId: string) {
    const sql = writer.sql
    const now = DateTime.formatIso(yield* DateTime.now)
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly in_main: number }>`
          SELECT space_id = ${mainSpaceIdSql(sql)} AS in_main FROM sessions
          WHERE session_id = ${sessionId}`
          const row = rows[0]
          if (row === undefined)
            return yield* storeError("onboarding", "not_found", "Chat not found", sessionId)
          if (row.in_main !== 1)
            return yield* storeError(
              "onboarding",
              "conflict",
              "Getting started runs only in a chat in the Main Space",
              sessionId
            )
          const marked = yield* sql<{ readonly session_id: string }>`
          UPDATE sessions SET metadata = json_set(COALESCE(metadata, '{}'), '$.onboarding',
            json_object('at', ${now}))
          WHERE session_id = ${sessionId} AND json_type(metadata, '$.onboarding') IS NULL
            AND NOT EXISTS (SELECT 1 FROM chat_idempotency_keys
              WHERE session_id = ${sessionId} AND client_id = ${onboardingClientId(sessionId)})
          RETURNING session_id`
          return marked.length > 0
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof SessionStoreError
            ? cause
            : storeError(
                "onboarding",
                "storage",
                "Could not start Getting started",
                sessionId,
                cause
              )
        )
      )
  }),
  finishOnboarding: Effect.fn("SqliteSessionStore.finishOnboarding")(function* (sessionId: string) {
    const updated = yield* writer
      .transact(
        writer.sql<{ readonly session_id: string }>`
          UPDATE sessions SET metadata = json_remove(metadata, '$.onboarding')
          WHERE session_id = ${sessionId} AND json_type(metadata, '$.onboarding') IS NOT NULL
          RETURNING session_id`
      )
      .pipe(
        Effect.mapError((cause) =>
          storeError("onboarding", "storage", "Could not end Getting started", sessionId, cause)
        )
      )
    return updated.length > 0
  })
})
