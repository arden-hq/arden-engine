import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { onboardingClientId, type SessionStore } from "../sessions/store.js"
import { mainSpaceIdSql } from "./main-space.js"
import { userChatSql } from "./chat-ownership.js"
import { chatHasActiveWork } from "./session-archive.js"
import type { PersistenceDeps } from "./deps.js"
import { storeError } from "./session-rows.js"
import type { Statement } from "effect/unstable/sql/Statement"
import type { Row } from "effect/unstable/sql/SqlConnection"

export const onboardingRefusal = Effect.fn("Onboarding.refusal")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string
) {
  const rows = yield* sql<{ readonly eligible: number; readonly busy: number }>`
    SELECT ${userChatSql("session")} AND session.parent_session_id IS NULL
        AND session.space_id = ${mainSpaceIdSql(sql)}
        AND json_type(session.metadata, '$.capture') IS NULL AS eligible,
      ${chatHasActiveWork(sql, sql`session`)} AS busy
    FROM sessions AS session WHERE session.session_id = ${sessionId}`
  const row = rows[0]
  if (row?.eligible !== 1) return "Getting started runs only in an ordinary chat in the Main Space"
  if (row.busy === 1) return "This chat is busy; try again once it is idle"
  return undefined
})

export const markOnboarding = (
  sql: SqlClient.SqlClient,
  sessionId: string,
  at: string
): Statement<Row> =>
  sql`UPDATE sessions SET metadata = json_set(COALESCE(metadata, '{}'), '$.onboarding',
      json_object('at', ${at}))
    WHERE session_id = ${sessionId} AND json_type(metadata, '$.onboarding') IS NULL`

export const makeSessionOnboarding = ({
  writer,
  reader
}: Pick<PersistenceDeps, "writer" | "reader">): Pick<
  SessionStore["Service"],
  "onboardingKickedOff" | "finishOnboarding"
> => ({
  onboardingKickedOff: (sessionId) =>
    reader<{ readonly kicked_off: number }>`SELECT EXISTS (SELECT 1 FROM chat_idempotency_keys
        WHERE session_id = ${sessionId} AND client_id = ${onboardingClientId(sessionId)})
      AS kicked_off`.pipe(
      Effect.map((rows) => rows[0]?.kicked_off === 1),
      Effect.mapError((cause) =>
        storeError("onboarding", "storage", "Could not read Getting started", sessionId, cause)
      )
    ),
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
