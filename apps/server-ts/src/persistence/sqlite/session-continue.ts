import type { ChatProjectionEvent } from "@arden-hq/protocol"
import { DateTime, Effect, Schema } from "effect"
import { SessionStoreError, type SessionStore } from "../sessions/store.js"
import { transcriptSearchText } from "../transcript/search-text.js"
import { StoredMessageEnvelopeSchema, visibleMessageCount } from "../transcript/model.js"
import type { PersistenceDeps } from "./deps.js"
import { decodeJson, encodeJson } from "./json.js"
import { sessionIdSchema, storeError } from "./session-rows.js"
import { requireActiveContextWindow, loadActiveContext } from "./active-context.js"
import { transactWithActiveContext } from "./active-context-stage.js"
import { activeRunStatusList } from "./status-sets.js"
import { userAutomationSql } from "./authority-sql.js"

export const makeSessionContinue = ({
  writer,
  sessionEvents,
  chatEvents
}: Pick<PersistenceDeps, "writer" | "sessionEvents" | "chatEvents">): Pick<
  SessionStore["Service"],
  "continueRun"
> => {
  const sql = writer.sql
  const continueRun = Effect.fn("SqliteSessionStore.continueRun")(function* (
    sessionId: string
  ): Effect.fn.Return<boolean, SessionStoreError> {
    const validSessionId = yield* Schema.decodeUnknownEffect(sessionIdSchema)(sessionId).pipe(
      Effect.mapError((cause) =>
        storeError("continue", "invalid", "Session id must not be empty", sessionId, cause)
      )
    )
    return yield* transactWithActiveContext(
      writer,
      "ordinary",
      { sessionId: validSessionId },
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly copy: number
          readonly working: number
          readonly automation_name: string | null
        }>`
            SELECT
              (s.session_type = 'chat' AND s.parent_session_id IS NOT NULL
                AND COALESCE(json_type(s.metadata, '$.fork_origin'),
                  json_type(s.metadata, '$.fork_of')) IS NOT NULL
                AND ${userAutomationSql("automation")}) AS copy,
              EXISTS (SELECT 1 FROM chat_runs AS run WHERE run.session_id = s.session_id
                AND run.status IN ${activeRunStatusList}) AS working,
              automation.name AS automation_name
            FROM sessions AS s
            LEFT JOIN scheduled_tasks AS automation ON automation.task_id = s.origin_automation_id
            WHERE s.session_id = ${validSessionId} AND s.archived_at IS NULL`
        const row = rows[0]
        if (row === undefined) return false
        if (row.copy !== 1) {
          return yield* storeError(
            "continue",
            "conflict",
            "Only the copy an Automation run worked in can continue as a chat",
            validSessionId
          )
        }
        if (row.working !== 0) {
          return yield* storeError(
            "continue",
            "conflict",
            "Wait for the run to finish, or stop it, before continuing it in a chat",
            validSessionId
          )
        }
        yield* requireActiveContextWindow(sql, validSessionId)
        const stored = yield* sql<{ readonly message_id: string; readonly message_json: string }>`
            SELECT message_id, message_json FROM session_messages
            WHERE session_id = ${validSessionId}
              AND json_type(message_json, '$.forked_from') IS NOT NULL`
        for (const message of stored) {
          const { forked_from: _source, ...own } = yield* decodeJson(
            StoredMessageEnvelopeSchema,
            message.message_json
          )
          yield* sql`UPDATE session_messages
              SET message_json = ${yield* encodeJson(StoredMessageEnvelopeSchema, own)},
                search_text = ${transcriptSearchText(own)}
              WHERE session_id = ${validSessionId} AND message_id = ${message.message_id}`
        }
        const projection = yield* loadActiveContext(sql, validSessionId)
        yield* sql`UPDATE sessions
            SET parent_session_id = NULL, parent_message_id = NULL, origin_automation_id = NULL,
              name = COALESCE(name, ${row.automation_name}),
              visible_message_count = ${visibleMessageCount(projection)},
              last_activity = ${DateTime.formatIso(yield* DateTime.now)}
            WHERE session_id = ${validSessionId}`
        yield* chatEvents.appendInTransaction({
          sessionId: validSessionId,
          events: [{ event: { type: "transcript_changed" } satisfies ChatProjectionEvent }]
        })
        yield* sessionEvents.appendInTransaction("session_created", validSessionId)
        return true
      })
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof SessionStoreError
          ? cause
          : storeError(
              "continue",
              "storage",
              "Could not continue the run in a chat",
              validSessionId,
              cause
            )
      )
    )
  })
  return { continueRun }
}
