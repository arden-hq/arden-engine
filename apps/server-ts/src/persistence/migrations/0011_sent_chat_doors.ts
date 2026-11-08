import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const SEND_TOOL = "session_send_message"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isSendCall = (call: unknown): call is Record<string, unknown> =>
  isRecord(call) && isRecord(call["function"]) && call["function"]["name"] === SEND_TOOL

const withSendsInConversation = (message: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(message) || !Array.isArray(message["tool_calls"])) return undefined
  let changed = false
  const calls = message["tool_calls"].map((call: unknown) => {
    if (!isSendCall(call) || call["presentation"] === "conversation") return call
    changed = true
    return { ...call, presentation: "conversation" }
  })
  return changed ? { ...message, tool_calls: calls } : undefined
}

const placeSendsInConversation = (database: DatabaseSync): void => {
  const rows = database
    .prepare(
      `SELECT session_id, message_id, message_json FROM session_messages
       WHERE role = 'assistant' AND message_json LIKE '%"${SEND_TOOL}"%'`
    )
    .all()
  const updateTranscript = database.prepare(
    "UPDATE session_messages SET message_json = ? WHERE session_id = ? AND message_id = ?"
  )
  const withSends = new Set<string>()
  for (const row of rows) {
    withSends.add(String(row.session_id))
    const next = withSendsInConversation(JSON.parse(String(row.message_json)))
    if (next !== undefined)
      updateTranscript.run(JSON.stringify(next), String(row.session_id), String(row.message_id))
  }
  const readProjection = database.prepare("SELECT messages FROM sessions WHERE session_id = ?")
  const updateProjection = database.prepare("UPDATE sessions SET messages = ? WHERE session_id = ?")
  for (const sessionId of withSends) {
    const messages = readProjection.get(sessionId)?.messages
    if (typeof messages !== "string") continue
    const parsed: unknown = JSON.parse(messages)
    if (!Array.isArray(parsed)) continue
    let changed = false
    const next = parsed.map((message: unknown) => {
      const placed = withSendsInConversation(message)
      if (placed === undefined) return message
      changed = true
      return placed
    })
    if (changed) updateProjection.run(JSON.stringify(next), sessionId)
  }
}

export const sentChatDoors: Migration = {
  version: 11,
  name: "sent_chat_doors",
  foreignKeys: { kind: "enforced" },
  up: placeSendsInConversation
}
