import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import {
  StoredMessageEnvelopeSchema,
  visibleMessageCount,
  type StoredMessageEnvelope
} from "../transcript/model.js"
import { hideFromActiveContext } from "./active-context.js"
import { decodeJson, encodeJson } from "./json.js"

interface SupersededRow {
  readonly seq: number
  readonly message_json: string
}

interface SupersededMessages {
  readonly active: ReadonlyArray<StoredMessageEnvelope>
  readonly answerIds: ReadonlyArray<string>
}

export const supersedeMessagesInTransaction = Effect.fn("SqlitePersistence.supersedeMessages")(
  function* (
    sql: SqlClient.SqlClient,
    input: {
      readonly sessionId: string
      readonly messageIds: ReadonlyArray<string>
      readonly active: ReadonlyArray<StoredMessageEnvelope>
    }
  ) {
    if (input.messageIds.length === 0) return { active: input.active, answerIds: [] }
    const rows = yield* sql<SupersededRow>`
      SELECT seq, message_json FROM session_messages
      WHERE session_id = ${input.sessionId} AND message_id IN ${sql.in([...input.messageIds])}
      ORDER BY seq
    `
    const activeIds = new Set(input.active.map((message) => message.message_id))
    const marked: Array<StoredMessageEnvelope> = []
    const leftContext: Array<StoredMessageEnvelope> = []
    for (const row of rows) {
      const message = yield* decodeJson(StoredMessageEnvelopeSchema, row.message_json)
      if (message.superseded === true) continue
      const json = yield* encodeJson(StoredMessageEnvelopeSchema, { ...message, superseded: true })
      yield* sql`
        UPDATE session_messages SET message_json = ${json}, search_text = NULL
        WHERE session_id = ${input.sessionId} AND seq = ${row.seq}
      `
      marked.push(message)
      if (activeIds.has(message.message_id)) {
        yield* hideFromActiveContext(sql, input.sessionId, row.seq)
        leftContext.push(message)
      }
    }
    if (leftContext.length > 0) {
      yield* sql`
        UPDATE sessions
        SET active_message_count = active_message_count - ${leftContext.length},
            visible_message_count = visible_message_count - ${visibleMessageCount(leftContext)}
        WHERE session_id = ${input.sessionId}
      `
    }
    const gone = new Set(leftContext.map((message) => message.message_id))
    return {
      active: input.active.filter((message) => !gone.has(message.message_id)),
      answerIds: marked
        .filter((message) => message.role === "assistant")
        .map((message) => message.message_id)
    } satisfies SupersededMessages
  }
)
