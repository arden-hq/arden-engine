import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { StoredMessageEnvelope } from "../transcript/model.js"
import { hasResumableTail } from "./chat-transcript.js"

export const completedRunReply = Effect.fn("RunCompletion.reply")(function* (
  sql: SqlClient.SqlClient,
  runId: string,
  messages: ReadonlyArray<StoredMessageEnvelope>
) {
  const last = messages.at(-1)
  if (last === undefined) return undefined
  const rows = yield* sql<{ readonly completion_message_id: string | null }>`
    SELECT completion_message_id FROM chat_runs WHERE run_id = ${runId}
  `
  if (rows[0]?.completion_message_id !== last.message_id) return undefined
  return hasResumableTail(messages, last.role === "tool") ? undefined : last
})
