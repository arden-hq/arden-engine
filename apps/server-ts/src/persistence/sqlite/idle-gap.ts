import { DateTime, Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ChatWriteError } from "../chat/store.js"

interface VisibleActivityRow {
  readonly created_at: string
}

const failure = (
  reason: ChatWriteError["reason"],
  message: string,
  sessionId: string,
  cause: unknown
): ChatWriteError =>
  new ChatWriteError({
    operation: "start",
    reason,
    message,
    sessionId,
    cause
  })

export const latestVisibleActivityMs = Effect.fn("SqliteChatWriteStore.latestVisibleActivity")(
  function* ({
    sql,
    sessionId
  }: {
    readonly sql: SqlClient.SqlClient
    readonly sessionId: string
  }): Effect.fn.Return<number | null, ChatWriteError> {
    const rows = yield* sql<VisibleActivityRow>`
    SELECT activity.created_at
    FROM (
      -- The transcript is appended in time order, so the newest visible
      -- message is the first one walking seq down: it stops there instead of
      -- parsing every message of a long chat on each send.
      SELECT * FROM (
        SELECT message.created_at
        FROM session_messages AS message
        WHERE message.session_id = ${sessionId}
          AND message.role IN ('user', 'assistant')
          AND COALESCE(json_extract(message.message_json, '$.is_meta'), 0) <> 1
          AND COALESCE(json_extract(message.message_json, '$.compaction.kind'), '')
            <> 'session_handoff'
        ORDER BY message.seq DESC
        LIMIT 1
      )
      UNION ALL
      SELECT receipt.created_at
      FROM chat_idempotency_keys AS receipt
      WHERE receipt.session_id = ${sessionId}
        AND receipt.status = 'queued'
        AND receipt.message_json IS NOT NULL
        AND json_extract(receipt.message_json, '$.role') IN ('user', 'assistant')
        AND COALESCE(json_extract(receipt.message_json, '$.is_meta'), 0) <> 1
    ) AS activity
    ORDER BY julianday(activity.created_at) DESC, activity.created_at DESC
    LIMIT 1
  `.pipe(
      Effect.mapError((cause) =>
        failure("storage", "Could not inspect prior visible Chat activity", sessionId, cause)
      )
    )
    const latest = rows[0]
    if (latest === undefined) return null
    const decoded = yield* Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(
      latest.created_at
    ).pipe(
      Effect.mapError((cause) =>
        failure("corrupt", "Prior visible Chat activity has an invalid timestamp", sessionId, cause)
      )
    )
    return DateTime.toEpochMillis(decoded)
  }
)
