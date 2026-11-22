import { DateTime, Effect } from "effect"
import { onboardingClientId, SessionStoreError, type SessionStore } from "../sessions/store.js"
import { mainSpaceIdSql } from "./main-space.js"
import { userChatSql } from "./chat-ownership.js"
import { chatHasActiveWork } from "./session-archive.js"
import type { PersistenceDeps } from "./deps.js"
import { storeError } from "./session-rows.js"

const refusalOf = (row: {
  readonly eligible: number
  readonly archived: number
  readonly busy: number
}): string | undefined => {
  if (row.eligible !== 1) return "Getting started runs only in an ordinary chat in the Main Space"
  if (row.archived === 1) return "This chat is archived"
  if (row.busy === 1) return "This chat is busy; try again once it is idle"
  return undefined
}

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
          const rows = yield* sql<{
            readonly eligible: number
            readonly archived: number
            readonly busy: number
            readonly kicked_off: number
          }>`
          SELECT ${userChatSql("session")} AND session.parent_session_id IS NULL
              AND session.space_id = ${mainSpaceIdSql(sql)}
              AND json_type(session.metadata, '$.capture') IS NULL AS eligible,
            session.archived_at IS NOT NULL AS archived,
            ${chatHasActiveWork(sql, sql`session`)} AS busy,
            EXISTS (SELECT 1 FROM chat_idempotency_keys AS kickoff
              WHERE kickoff.session_id = session.session_id
                AND kickoff.client_id = ${onboardingClientId(sessionId)}) AS kicked_off
          FROM sessions AS session WHERE session.session_id = ${sessionId}`
          const row = rows[0]
          if (row === undefined)
            return yield* storeError("onboarding", "not_found", "Chat not found", sessionId)
          if (row.kicked_off === 1) return "kicked_off" as const
          const refusal = refusalOf(row)
          if (refusal !== undefined)
            return yield* storeError("onboarding", "conflict", refusal, sessionId)
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
