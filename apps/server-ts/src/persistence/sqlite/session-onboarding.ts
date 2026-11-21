import { Effect } from "effect"
import type { SessionStore } from "../sessions/store.js"
import type { PersistenceDeps } from "./deps.js"
import { storeError } from "./session-rows.js"

export const makeSessionOnboarding = ({
  writer
}: Pick<PersistenceDeps, "writer">): Pick<SessionStore["Service"], "finishOnboarding"> => ({
  finishOnboarding: Effect.fn("SqliteSessionStore.finishOnboarding")(function* (sessionId: string) {
    const updated = yield* writer
      .run(
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
