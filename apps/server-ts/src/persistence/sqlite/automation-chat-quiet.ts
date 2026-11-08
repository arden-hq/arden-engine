import type { EventAutomationTrigger } from "@arden-hq/protocol/automations"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"

import { renderEvent } from "../automations/event-text.js"
import { runOnlyIfSentences } from "../automations/event-words.js"
import type { AutomationRules, QuietChat } from "../automations/model.js"
import { enqueue, freshRow, type QueueWriter } from "./automation-enqueue.js"
import { iso } from "../../runtime/clock.js"

const QUIET_AFTER_MS = 10 * 60_000

export const loadQuietChat = Effect.fn("SqliteAutomationStore.loadQuietChat")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string
) {
  const rows = yield* sql<{
    readonly public_ref: string
    readonly name: string | null
    readonly space_name: string | null
  }>`
    SELECT s.public_ref, s.name, d.name AS space_name
    FROM sessions AS s LEFT JOIN spaces AS d ON d.space_id = s.space_id
    WHERE s.session_id = ${sessionId}
      AND s.archived_at IS NULL
  `
  const chat = rows[0]
  if (chat === undefined) return null
  const messages = yield* sql<{
    readonly seq: number
    readonly role: "user" | "assistant"
    readonly created_at: string
    readonly text: string | null
  }>`
    SELECT seq, role, created_at, search_text AS text FROM session_messages
    WHERE session_id = ${sessionId}
      AND role IN ('user', 'assistant')
      AND json_extract(message_json, '$.is_meta') IS NOT 1
    ORDER BY seq DESC
    LIMIT 200
  `
  return {
    sessionId,
    publicRef: chat.public_ref,
    name: chat.name,
    spaceName: chat.space_name,
    messages: messages.map((message) => ({
      seq: message.seq,
      role: message.role,
      createdAt: message.created_at,
      text: message.text ?? ""
    }))
  } satisfies QuietChat
})

export const armChatQuiet = Effect.fn("SqliteAutomationStore.armChatQuiet")(function* (input: {
  readonly writer: QueueWriter
  readonly rules: AutomationRules["Service"]
  readonly automationId: string
  readonly trigger: EventAutomationTrigger
  readonly chat: QuietChat
  readonly atMs: number
  readonly nowMs: number
}) {
  const { sql } = input.writer
  const pendingKey = `chat.quiet:${input.chat.sessionId}`
  const event = input.rules.chatQuietEvent(input.chat)
  if (event === undefined || !input.rules.eventMatches(input.trigger, event)) {
    yield* sql`
      DELETE FROM automation_event_queue
      WHERE task_id = ${input.automationId} AND source = 'event' AND event_key = ${pendingKey}
        AND ${freshRow(sql)}
    `
    return
  }
  const snapshot = {
    queued_at: iso(input.nowMs),
    event_type: event.eventType,
    event_key: event.eventKey,
    produced_by: event.producedBy,
    context: event.context
  }
  const runOnlyIf = runOnlyIfSentences([input.trigger])
  yield* enqueue(input.writer, {
    automationId: input.automationId,
    source: "event",
    key: pendingKey,
    once: `${pendingKey}:${event.eventKey}`,
    dueAt: input.atMs + QUIET_AFTER_MS,
    pending: "replace",
    context: {
      scheduled_for: null,
      automation_run_id: null,
      trigger_context: renderEvent(snapshot, input.nowMs),
      trigger_context_snapshot: { source: "event", ...snapshot },
      ...(runOnlyIf === undefined ? {} : { run_only_if: runOnlyIf })
    }
  })
})

export const triggerChangeText = Effect.fn("SqliteAutomationStore.triggerChangeText")(function* (
  sql: SqlClient.SqlClient,
  trigger:
    | { readonly source: "idle"; readonly input_at: string }
    | {
        readonly source: "count"
        readonly session_id: string
        readonly through_sequence: number | null
        readonly every_n: number
      }
) {
  if (trigger.source === "idle") {
    return `## Why this run\nThe user has written nothing since ${trigger.input_at}. Anything they said before then is already known; nothing new has arrived since.`
  }
  const rows = yield* sql<{ readonly public_ref: string; readonly name: string | null }>`
      SELECT public_ref, name FROM sessions WHERE session_id = ${trigger.session_id}
    `
  const chat = rows[0]
  if (chat === undefined) {
    return `## Why this run\nA chat reached ${trigger.every_n} finished runs.`
  }
  const through =
    trigger.through_sequence === null ? "" : `, through message ${trigger.through_sequence}`
  return [
    "## Why this run",
    `Chat ${JSON.stringify(chat.name ?? "Untitled chat")} (session_ref ${chat.public_ref}) reached ${trigger.every_n} finished runs since this Automation last counted${through}.`,
    `Read what changed with session_read(session_ref="${chat.public_ref}"${trigger.through_sequence === null ? "" : `, around_seq=${trigger.through_sequence}`}).`
  ].join("\n")
})
