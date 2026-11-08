import { Effect, Schema } from "effect"
import { CaptureForwardSchema, type CaptureForward } from "../sessions/capture.js"
import type { SessionStore } from "../sessions/store.js"
import { SessionStoreError } from "../sessions/store.js"
import type { PersistenceDeps } from "./deps.js"
import { encodeJsonWith } from "./json.js"
import { sessionIdSchema, storeError } from "./session-rows.js"

export const makeSessionCaptureRecords = ({
  writer
}: Pick<PersistenceDeps, "writer">): Pick<SessionStore["Service"], "saveCaptureForward"> => {
  const sql = writer.sql
  const saveCaptureForward = Effect.fn("SqliteSessionStore.saveCaptureForward")(function* (
    sessionId: string,
    forwarded: CaptureForward
  ): Effect.fn.Return<boolean, SessionStoreError> {
    const validSessionId = yield* Schema.decodeUnknownEffect(sessionIdSchema)(sessionId).pipe(
      Effect.mapError((cause) =>
        storeError("capture", "invalid", "Session id must not be empty", sessionId, cause)
      )
    )
    const text = yield* encodeJsonWith(CaptureForwardSchema, forwarded, (cause) =>
      storeError("capture", "invalid", "Capture forward cannot be stored", validSessionId, cause)
    )
    const updated = yield* writer
      .transact(
        sql<{ readonly session_id: string }>`
      UPDATE sessions SET metadata = json_set(metadata, '$.capture.forwarded', json(${text}))
      WHERE session_id = ${validSessionId} AND archived_at IS NULL
        AND json_type(metadata, '$.capture') = 'object'
      RETURNING session_id
    `
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof SessionStoreError
            ? cause
            : storeError(
                "capture",
                "storage",
                "Could not store the capture forward",
                validSessionId,
                cause
              )
        )
      )
    return updated.length > 0
  })
  return { saveCaptureForward }
}
