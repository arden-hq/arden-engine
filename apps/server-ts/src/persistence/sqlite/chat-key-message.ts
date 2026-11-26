import { Effect } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import { REQUEST_HASH_VERSION } from "../chat/store.js"
import type { Row } from "effect/unstable/sql/SqlConnection"

// A chat idempotency key holds its message only while the message is not in
// the transcript (queued input, or a transcript cleared or reverted past it).
// Once the message is in session_messages, that row is the one copy, and every
// reader reads the key's message through keyMessageJson.

/** The message of the key row `alias`: its own copy, or the transcript message
 * with its id. */
export const keyMessageJson = (sql: SqlClient.SqlClient, alias: string): Statement.Fragment =>
  sql`COALESCE(${sql(alias)}.message_json, (
    SELECT transcript.message_json FROM session_messages AS transcript
    WHERE transcript.session_id = ${sql(alias)}.session_id
      AND transcript.message_id = ${sql(alias)}.message_id
  ))`

/** Records a chat idempotency key. It keeps a copy of its message only when
 * the message is not in the transcript yet. */
export const insertChatKey = (
  sql: SqlClient.SqlClient,
  key: {
    readonly sessionId: string
    readonly clientId: string
    readonly requestHash: string
    readonly runId: string | null
    readonly messageId: string
    readonly messageJson: string
    readonly status: "accepted" | "queued" | "running"
    readonly at: string
  }
): Statement.Statement<Row> => sql`
  INSERT INTO chat_idempotency_keys (
    session_id, client_id, request_hash, request_hash_version, run_id, message_id, message_json,
    status, created_at, updated_at
  ) VALUES (
    ${key.sessionId}, ${key.clientId}, ${key.requestHash}, ${REQUEST_HASH_VERSION}, ${key.runId},
    ${key.messageId},
    CASE WHEN EXISTS (
      SELECT 1 FROM session_messages
      WHERE session_id = ${key.sessionId} AND message_id = ${key.messageId}
    ) THEN NULL ELSE ${key.messageJson} END,
    ${key.status}, ${key.at}, ${key.at}
  )
`

/** Drops the copies of the keys whose messages were just written to the
 * transcript, in the transaction that wrote them. An admitted message carries
 * its key's client id. */
export const releaseKeyMessageCopies = Effect.fn("SqlitePersistence.releaseKeyMessageCopies")(
  function* (
    sql: SqlClient.SqlClient,
    sessionId: string,
    messages: ReadonlyArray<{ readonly message_id: string; readonly client_id?: string }>
  ) {
    for (const message of messages) {
      if (message.client_id === undefined) continue
      yield* sql`
        UPDATE chat_idempotency_keys SET message_json = NULL
        WHERE session_id = ${sessionId} AND client_id = ${message.client_id}
          AND message_id = ${message.message_id} AND message_json IS NOT NULL
      `
    }
  }
)

/** Gives keys back their message before the transcript messages are deleted:
 * every message of the session, or only `messageIds`. */
export const restoreKeyMessageCopies = Effect.fn("SqlitePersistence.restoreKeyMessageCopies")(
  function* (sql: SqlClient.SqlClient, sessionId: string, messageIds?: ReadonlyArray<string>) {
    if (messageIds !== undefined && messageIds.length === 0) return
    const only =
      messageIds === undefined ? sql`` : sql`AND receipt.message_id IN ${sql.in([...messageIds])}`
    yield* sql`
      UPDATE chat_idempotency_keys AS receipt
      SET message_json = (
        SELECT transcript.message_json FROM session_messages AS transcript
        WHERE transcript.session_id = receipt.session_id AND transcript.message_id = receipt.message_id
      )
      WHERE receipt.session_id = ${sessionId} AND receipt.message_json IS NULL ${only}
    `
  }
)
