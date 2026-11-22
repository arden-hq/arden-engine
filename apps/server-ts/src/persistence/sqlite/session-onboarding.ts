import { DateTime, Effect } from "effect"
import { onboardingClientId, SessionStoreError, type SessionStore } from "../sessions/store.js"
import { mainSpaceIdSql } from "./main-space.js"
import { userChatSql } from "./chat-ownership.js"
import type { PersistenceDeps } from "./deps.js"
import { storeError } from "./session-rows.js"

export const makeSessionOnboarding = ({
  writer
}: Pick<PersistenceDeps, "writer">): Pick<
  SessionStore["Service"],
  "markOnboarding" | "finishOnboarding"
> => ({
  markOnboarding: Effect.fn("SqliteSessionStore.markOnboarding")(function* (sessionId: string) {
    const sql = writer.sql
    const now = DateTime.formatIso(yield* DateTime.now)
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly eligible: number; readonly kicked_off: number }>`
          SELECT ${userChatSql("session")} AND session.parent_session_id IS NULL
              AND session.space_id = ${mainSpaceIdSql(sql)}
              AND json_type(session.metadata, '$.capture') IS NULL AS eligible,
            EXISTS (SELECT 1 FROM chat_idempotency_keys AS kickoff
              WHERE kickoff.session_id = session.session_id
                AND kickoff.client_id = ${onboardingClientId(sessionId)}) AS kicked_off
          FROM sessions AS session WHERE session.session_id = ${sessionId}`
          const row = rows[0]
          if (row === undefined)
            return yield* storeError("onboarding", "not_found", "Chat not found", sessionId)
          if (row.eligible !== 1)
            return yield* storeError(
              "onboarding",
              "conflict",
              "Getting started runs only in an ordinary chat in the Main Space",
              sessionId
            )
          if (row.kicked_off === 1) return "kicked_off" as const
          yield* sql`UPDATE sessions SET metadata = json_set(COALESCE(metadata, '{}'), '$.onboarding',
              json_object('at', ${now}))
            WHERE session_id = ${sessionId} AND json_type(metadata, '$.onboarding') IS NULL`
          return "marked" as const
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
