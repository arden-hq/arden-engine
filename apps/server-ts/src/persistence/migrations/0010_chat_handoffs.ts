import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const SEND_PREFIX = "session-send:"
const CHOICE_LABEL_MAX = 160

interface FromChat {
  readonly session_id: string
  readonly session_ref: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const withFromChat = (json: string, fromChat: FromChat): string | undefined => {
  const parsed: unknown = JSON.parse(json)
  if (!isRecord(parsed) || parsed["from_chat"] !== undefined) return undefined
  return JSON.stringify({ ...parsed, from_chat: fromChat })
}

const stampHandoffs = (database: DatabaseSync): void => {
  const sent = database
    .prepare(
      `SELECT session_id, message_id, client_id, message_json FROM session_messages
       WHERE role = 'user' AND message_rowid IN (
         SELECT message_rowid FROM session_messages WHERE client_id LIKE '${SEND_PREFIX}%'
       )`
    )
    .all()
    .map((row) => ({
      session_id: String(row.session_id),
      message_id: String(row.message_id),
      client_id: String(row.client_id),
      message_json: String(row.message_json)
    }))
  const sourceOf = database.prepare(
    `SELECT source.session_id, source.public_ref FROM chat_runs AS run
     JOIN sessions AS source ON source.session_id = run.session_id
     WHERE run.run_id = ?`
  )
  const updateTranscript = database.prepare(
    "UPDATE session_messages SET message_json = ? WHERE session_id = ? AND message_id = ?"
  )
  const readKey = database.prepare(
    "SELECT message_json FROM chat_idempotency_keys WHERE session_id = ? AND client_id = ?"
  )
  const updateKey = database.prepare(
    "UPDATE chat_idempotency_keys SET message_json = ? WHERE session_id = ? AND client_id = ?"
  )
  const stamped = new Map<string, Map<string, FromChat>>()
  for (const row of sent) {
    const runId = row.client_id.slice(SEND_PREFIX.length).split(":")[0]
    if (runId === undefined || runId === "") continue
    const source = sourceOf.get(runId)
    if (source === undefined || String(source.session_id) === row.session_id) continue
    const fromChat = {
      session_id: String(source.session_id),
      session_ref: String(source.public_ref)
    }
    const next = withFromChat(row.message_json, fromChat)
    if (next === undefined) continue
    updateTranscript.run(next, row.session_id, row.message_id)
    const key = readKey.get(row.session_id, row.client_id)?.message_json
    const keyed = typeof key === "string" ? withFromChat(key, fromChat) : undefined
    if (keyed !== undefined) updateKey.run(keyed, row.session_id, row.client_id)
    const bySession = stamped.get(row.session_id) ?? new Map<string, FromChat>()
    bySession.set(row.message_id, fromChat)
    stamped.set(row.session_id, bySession)
  }
  const readProjection = database.prepare("SELECT messages FROM sessions WHERE session_id = ?")
  const updateProjection = database.prepare("UPDATE sessions SET messages = ? WHERE session_id = ?")
  for (const [sessionId, byMessage] of stamped) {
    const messages = readProjection.get(sessionId)?.messages
    if (typeof messages !== "string") continue
    const parsed: unknown = JSON.parse(messages)
    if (!Array.isArray(parsed)) continue
    let changed = false
    const next = parsed.map((message: unknown) => {
      if (!isRecord(message) || typeof message["message_id"] !== "string") return message
      const fromChat = byMessage.get(message["message_id"])
      if (fromChat === undefined || message["from_chat"] !== undefined) return message
      changed = true
      return { ...message, from_chat: fromChat }
    })
    if (changed) updateProjection.run(JSON.stringify(next), sessionId)
  }
}

const doorWords = (target: Record<string, unknown>): string | undefined => {
  if (target["kind"] === "existing" && typeof target["label"] === "string")
    return `Continue in ${target["label"]}`
  if (target["kind"] === "create" && typeof target["name"] === "string")
    return `Open a new chat: ${target["name"]}`
  return undefined
}

const openLabel = (target: Record<string, unknown>): string | undefined => {
  const label = doorWords(target)
  if (label === undefined) return undefined
  return label.length <= CHOICE_LABEL_MAX ? label : `${label.slice(0, CHOICE_LABEL_MAX - 1)}…`
}

const nameFocusDoors = (database: DatabaseSync): void => {
  const rows = database
    .prepare(
      `SELECT question.question_id, question.content, choice.target_json
       FROM run_questions AS question
       JOIN focus_choices AS choice ON choice.question_id = question.question_id`
    )
    .all()
    .map((row) => ({
      question_id: String(row.question_id),
      content: String(row.content),
      target_json: String(row.target_json)
    }))
  const update = database.prepare("UPDATE run_questions SET content = ? WHERE question_id = ?")
  for (const row of rows) {
    const content: unknown = JSON.parse(row.content)
    const target: unknown = JSON.parse(row.target_json)
    if (!isRecord(content) || !isRecord(target) || !Array.isArray(content["choices"])) continue
    const label = openLabel(target)
    if (label === undefined) continue
    let changed = false
    const choices = content["choices"].map((choice: unknown) => {
      if (!isRecord(choice) || choice["id"] !== "open_target" || choice["label"] === label)
        return choice
      changed = true
      return { ...choice, label }
    })
    if (changed) update.run(JSON.stringify({ ...content, choices }), row.question_id)
  }
}

export const chatHandoffs: Migration = {
  version: 10,
  name: "chat_handoffs",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    stampHandoffs(database)
    nameFocusDoors(database)
  }
}
