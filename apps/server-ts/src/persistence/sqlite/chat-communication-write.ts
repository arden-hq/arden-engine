import { INTERACTION_KIND, INTERACTION_SOURCE, ROLE } from "@arden-hq/std/message-vocabulary"
import type { CommunicationEnvelope } from "@arden-hq/protocol/chat"
import { CommunicationEnvelopeSchema } from "@arden-hq/protocol/effect/chat"
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import { messageAuthor, StoredMessageEnvelopeSchema } from "../transcript/model.js"
import { hideFromActiveContext } from "./active-context.js"
import { liftChat } from "./session-unread.js"

export const writeCommunicationEnvelopeInTransaction = Effect.fn(
  "SqliteTranscript.writeCommunicationEnvelope"
)(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly sessionEvents: Pick<
    SessionLifecycleEvents["Service"],
    "appendEventInTransaction" | "appendInTransaction"
  >
  readonly sessionId: string
  readonly messageId: string
  readonly envelope: CommunicationEnvelope
  readonly createdAt: string
  readonly replace: boolean
  readonly quiet: boolean
}) {
  const communication = yield* Schema.decodeUnknownEffect(CommunicationEnvelopeSchema)(
    options.envelope
  )
  const message = yield* Schema.decodeUnknownEffect(StoredMessageEnvelopeSchema)({
    message_id: options.messageId,
    turn_id: options.messageId,
    role: ROLE.interaction,
    from: { source: INTERACTION_SOURCE.harness, id: "communication" },
    kind: INTERACTION_KIND.event,
    content: "",
    communication,
    created_at: options.createdAt
  })
  const messageJson = JSON.stringify(message)
  const existing = yield* options.sql<{ readonly message_json: string; readonly seq: number }>`
    SELECT message_json, seq FROM session_messages
    WHERE session_id = ${options.sessionId} AND message_id = ${options.messageId}
  `
  const stored = existing[0]
  if (stored !== undefined) {
    if (stored.message_json === messageJson) return "unchanged" as const
    if (!options.replace) throw new Error("Static communication message identity changed")
    yield* options.sql`UPDATE session_messages
      SET message_json = ${messageJson}, created_at = ${options.createdAt}, search_text = NULL
      WHERE session_id = ${options.sessionId} AND message_id = ${options.messageId}`
    yield* options.sql`UPDATE session_turns
      SET started_at = ${options.createdAt}, ended_at = ${options.createdAt}
      WHERE session_id = ${options.sessionId} AND turn_id = ${options.messageId}`
    if (!options.quiet)
      yield* liftChat(options.sql, options.sessionEvents, {
        sessionId: options.sessionId,
        at: options.createdAt
      })
    return "replaced" as const
  }

  const session = yield* options.sql`SELECT 1 FROM sessions
    WHERE session_id = ${options.sessionId} AND archived_at IS NULL
      AND session_type IN ('chat', 'channel')`
  if (session.length === 0) throw new Error("Static communication destination is unavailable")
  const sequences = yield* options.sql<{ readonly sequence: number; readonly turn_index: number }>`
    SELECT
      COALESCE((SELECT MAX(seq) + 1 FROM session_messages
        WHERE session_id = ${options.sessionId}), 0) AS sequence,
      COALESCE((SELECT MAX(turn_index) + 1 FROM session_turns
        WHERE session_id = ${options.sessionId}), 0) AS turn_index
  `
  const sequence = sequences[0]?.sequence ?? 0
  const turnIndex = sequences[0]?.turn_index ?? 0
  yield* options.sql`INSERT INTO session_messages (
      session_id, message_id, seq, role, message_json, client_id, created_at, search_text, author
    ) VALUES (
      ${options.sessionId}, ${options.messageId}, ${sequence}, 'interaction', ${messageJson}, NULL,
      ${options.createdAt}, NULL, ${messageAuthor(message)}
    )`
  yield* hideFromActiveContext(options.sql, options.sessionId, sequence)
  yield* options.sql`INSERT INTO session_turns (
      session_id, turn_id, turn_index, user_message_id, message_start_id, message_end_id,
      message_start_seq, message_end_seq, started_at, ended_at
    ) VALUES (
      ${options.sessionId}, ${options.messageId}, ${turnIndex}, ${options.messageId},
      ${options.messageId}, ${options.messageId}, ${sequence}, ${sequence},
      ${options.createdAt}, ${options.createdAt}
    )`
  if (!options.quiet)
    yield* liftChat(options.sql, options.sessionEvents, {
      sessionId: options.sessionId,
      at: options.createdAt
    })
  return "inserted" as const
})
