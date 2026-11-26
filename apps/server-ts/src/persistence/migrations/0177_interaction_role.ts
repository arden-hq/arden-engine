import { parseJsonText } from "@arden-hq/protocol/common"
import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

export const interactionRole: Migration = {
  version: 177,
  name: "interaction_role",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(`DROP TRIGGER session_messages_role_insert`)
    database.exec(`DROP TRIGGER session_messages_role_update`)
    database.exec(`CREATE TRIGGER session_messages_role_insert
      BEFORE INSERT ON session_messages
      WHEN NEW.role NOT IN ('system', 'developer', 'user', 'interaction', 'assistant', 'tool')
      BEGIN
        SELECT RAISE(ABORT, 'Unknown transcript message role');
      END`)
    database.exec(`CREATE TRIGGER session_messages_role_update
      BEFORE UPDATE OF role ON session_messages
      WHEN NEW.role NOT IN ('system', 'developer', 'user', 'interaction', 'assistant', 'tool')
      BEGIN
        SELECT RAISE(ABORT, 'Unknown transcript message role');
      END`)
    database.exec(`DROP TRIGGER chat_upload_unlisted_ai`)
    database.exec(`CREATE TRIGGER chat_upload_unlisted_ai
      AFTER INSERT ON session_messages
      WHEN new.role IN ('user', 'interaction') AND instr(new.message_json, '/uploads/') > 0 BEGIN
        INSERT OR IGNORE INTO chat_upload_unlisted(message_rowid) VALUES (new.message_rowid);
      END`)
    convertTranscript(database)
    convertReceipts(database)
    database.exec(`ALTER TABLE chat_idempotency_keys
      ADD COLUMN request_hash_version INTEGER NOT NULL DEFAULT 1 CHECK(request_hash_version >= 1)`)
    convertRunStartEvents(database)
  }
}

type Json = Record<string, unknown>

const storedJson = (column: unknown): Json => parseJsonText(String(column)) as Json

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const MESSAGE_ROLE = {
  system: "system",
  developer: "developer",
  user: "user",
  interaction: "interaction",
  assistant: "assistant",
  tool: "tool"
} as const
type MessageRole = (typeof MESSAGE_ROLE)[keyof typeof MESSAGE_ROLE]
const isMessageRole = (value: unknown): value is MessageRole =>
  Object.values<unknown>(MESSAGE_ROLE).includes(value)

const PARTICIPANT_TYPE = { user: "user", agent: "agent" } as const
type ParticipantType = (typeof PARTICIPANT_TYPE)[keyof typeof PARTICIPANT_TYPE]
const isParticipant = (value: unknown, type: ParticipantType): value is Json =>
  isObject(value) && value.type === type

const INTERACTION_KIND = { completion: "completion" } as const
type InteractionKind = (typeof INTERACTION_KIND)[keyof typeof INTERACTION_KIND]
const isInteractionKind = (interaction: Json, kind: InteractionKind): boolean =>
  interaction.kind === kind

const MARKED = `(instr(message_json, '"is_meta"') > 0
  OR instr(message_json, '"interaction"') > 0
  OR instr(message_json, '"automation"') > 0)`

const actor = (from: Json): Json => ({
  source: from.type === PARTICIPANT_TYPE.user ? "harness" : from.type,
  id: from.id,
  ...(typeof from.display_name === "string" ? { name: from.display_name } : {})
})

const senderOf = (interaction: Json): Json => {
  const from = isObject(interaction.from) ? interaction.from : {}
  const to = interaction.to
  const fromPerson = from.type === PARTICIPANT_TYPE.user
  return {
    from: actor(from),
    ...(isParticipant(to, PARTICIPANT_TYPE.agent) ? { to: { source: "agent", id: to.id } } : {}),
    kind: fromPerson ? "event" : interaction.kind,
    ...(isInteractionKind(interaction, INTERACTION_KIND.completion) && !fromPerson
      ? { outcome: interaction.outcome }
      : {}),
    ...(typeof interaction.preview === "string" ? { preview: interaction.preview } : {}),
    ...(isObject(interaction.causedBy) ? { caused_by: interaction.causedBy } : {})
  }
}

const convertMessage = (message: Json): Json | undefined => {
  const { is_meta: meta, interaction, ...rest } = message
  const role = rest.role
  if (!isMessageRole(role)) return undefined
  if (role === MESSAGE_ROLE.developer) return meta === undefined ? undefined : rest
  if (role === MESSAGE_ROLE.assistant) {
    if (meta !== true) return meta === undefined ? undefined : rest
    return {
      ...rest,
      role: "interaction",
      from: { source: "harness", id: "automation_headline" },
      kind: "event"
    }
  }
  if (role !== MESSAGE_ROLE.user) return undefined
  if (isObject(interaction)) {
    const sender = senderOf(interaction)
    const content = typeof interaction.content === "string" ? interaction.content : rest.content
    const preview =
      sender.preview === undefined && typeof rest.content === "string" && rest.content !== content
        ? { preview: rest.content }
        : {}
    return { ...rest, role: "interaction", ...sender, ...preview, content }
  }
  const automation = rest.automation
  if (isObject(automation))
    return {
      ...rest,
      role: "interaction",
      from: {
        source: "automation",
        id: automation.task_id,
        ...(typeof automation.name === "string" ? { name: automation.name } : {})
      },
      kind: "assignment"
    }
  if (meta !== true) return meta === undefined ? undefined : rest
  if (rest.question_answer !== undefined || rest.forwarded_from !== undefined) return rest
  return {
    ...rest,
    role: "interaction",
    from: { source: "harness", id: harnessId(rest) },
    kind: "event"
  }
}

const harnessId = (message: Json): string => {
  if (message.communication !== undefined) return "communication"
  if (message.chat_events === true) return "chat_events"
  if (message.update !== undefined) return "update"
  if (message.connection !== undefined) return "connection"
  return String(message.client_id ?? message.message_id ?? "notice")
}

const convertTranscript = (database: DatabaseSync): void => {
  const rows = database
    .prepare(
      `SELECT message_rowid, message_json FROM session_messages
      WHERE (role IN ('user', 'developer') AND ${MARKED})
        OR (role = 'assistant' AND message_id LIKE 'headline:%')`
    )
    .all()
  const update = database.prepare(
    "UPDATE session_messages SET role = ?, message_json = ? WHERE message_rowid = ?"
  )
  for (const row of rows) {
    const converted = convertMessage(storedJson(row.message_json))
    if (converted === undefined) continue
    update.run(String(converted.role), JSON.stringify(converted), Number(row.message_rowid))
  }
}

const convertReceipts = (database: DatabaseSync): void => {
  const rows = database
    .prepare(
      `SELECT session_id, client_id, message_json FROM chat_idempotency_keys
      WHERE message_json IS NOT NULL AND ${MARKED}`
    )
    .all()
  const update = database.prepare(
    "UPDATE chat_idempotency_keys SET message_json = ? WHERE session_id = ? AND client_id = ?"
  )
  for (const row of rows) {
    const converted = convertMessage(storedJson(row.message_json))
    if (converted === undefined) continue
    update.run(JSON.stringify(converted), String(row.session_id), String(row.client_id))
  }
}

const convertRunStartEvents = (database: DatabaseSync): void => {
  const rows = database
    .prepare(
      `SELECT stream_id, sequence, data_json FROM journal_records
      WHERE event_type = 'RUN_STARTED' AND instr(data_json, '"interaction"') > 0`
    )
    .all()
  const update = database.prepare(
    "UPDATE journal_records SET data_json = ? WHERE stream_id = ? AND sequence = ?"
  )
  for (const row of rows) {
    const event = storedJson(row.data_json)
    const interaction = event.interaction
    if (
      !isObject(interaction) ||
      !isObject(interaction.from) ||
      interaction.from.type === undefined
    )
      continue
    const converted = { ...senderOf(interaction), content: interaction.content }
    update.run(
      JSON.stringify({ ...event, interaction: converted }),
      String(row.stream_id),
      Number(row.sequence)
    )
  }
}
