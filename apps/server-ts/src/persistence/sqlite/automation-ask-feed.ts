import { freshRow } from "./automation-enqueue.js"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"

import { causedChainDepth } from "../automations/chain-depth.js"
import type { AskFeedRow, AskRef } from "../automations/model.js"
import { runColumns, runDestinationSessionId } from "./run-destination.js"
import { causingAutomation, causingWakeDepth } from "./run-cause.js"
import { pendingDecisionCards } from "./pending-decision-cards.js"
import { queuedEventType } from "./automation-listening.js"

interface AskSqlRow {
  readonly ask_key: string
  readonly kind: "question" | "approval" | "connection"
  readonly text: string | null
  readonly detail: string | null
  readonly tool_name: string | null
  readonly asked_at: string
  readonly session_id: string | null
  readonly public_ref: string | null
  readonly chat_name: string | null
  readonly space_name: string | null
  readonly produced_by: string | null
  readonly automation_name: string | null
  readonly chain_depth: number
}

export const readOpenAsk = Effect.fnUntraced(function* (sql: SqlClient.SqlClient, ask: AskRef) {
  const runJoins = sql`LEFT JOIN scheduled_tasks AS automation
    ON automation.task_id = ${causingAutomation(sql, "run")}`
  const cards = (runId: string, toolCallId: string) => sql`
    SELECT 'approval:' || card.run_id || ':' || card.tool_call_id AS ask_key,
      CASE json_extract(card.payload_json, '$.approval_data._tag')
        WHEN 'ConnectionRequired' THEN 'connection' ELSE 'approval' END AS kind,
      COALESCE(card.preview, card.action) AS text, NULL AS detail,
      card.tool_name, card.requested_at AS asked_at,
      chat.session_id, chat.public_ref, chat.name AS chat_name, space.name AS space_name,
      ${causingAutomation(sql, "run")} AS produced_by, automation.name AS automation_name,
      ${causingWakeDepth(sql, "run")} AS chain_depth
    FROM (${pendingDecisionCards(sql)}) AS card
    JOIN chat_runs AS run ON run.run_id = card.run_id
    ${runJoins}
    LEFT JOIN sessions AS chat ON chat.session_id = card.destination_session_id
    LEFT JOIN spaces AS space ON space.space_id = chat.space_id
    WHERE card.run_id = ${runId} AND card.tool_call_id = ${toolCallId}
      AND card.kind = 'tool_approval'`
  const rows =
    ask.kind === "question"
      ? yield* sql<AskSqlRow>`
          SELECT 'question:' || question.question_id AS ask_key, 'question' AS kind,
            json_extract(question.content, '$.prompt') AS text,
            json_extract(question.content, '$.detail') AS detail,
            NULL AS tool_name, question.created_at AS asked_at,
            chat.session_id, chat.public_ref, chat.name AS chat_name, space.name AS space_name,
            ${causingAutomation(sql, "run")} AS produced_by, automation.name AS automation_name,
            ${causingWakeDepth(sql, "run")} AS chain_depth
          FROM run_questions AS question
          JOIN chat_runs AS run ON run.run_id = question.run_id
          ${runJoins}
          LEFT JOIN sessions AS chat ON chat.session_id = ${runDestinationSessionId(sql, runColumns(sql, "run"))}
          LEFT JOIN spaces AS space ON space.space_id = chat.space_id
          WHERE question.question_id = ${ask.questionId}
            AND question.resolution IS NULL AND question.closed_at IS NULL`
      : yield* sql<AskSqlRow>`${cards(ask.runId, ask.toolCallId)} LIMIT 1`
  const row = rows[0]
  return row === undefined ? undefined : askRow(row)
})

const askOfKey = (key: string): AskRef | undefined => {
  if (key.startsWith("question:")) return { kind: "question", questionId: key.slice(9) }
  const card = /^approval:(.+):([^:]+)$/u.exec(key)
  return card?.[1] === undefined || card[2] === undefined
    ? undefined
    : { kind: "card", runId: card[1], toolCallId: card[2] }
}

export const dropClosedAsks = Effect.fnUntraced(function* (sql: SqlClient.SqlClient, now: string) {
  const due = yield* sql<{ readonly id: number; readonly ask_key: string }>`
    SELECT id, json_extract(context, '$.trigger_context_snapshot.event_key') AS ask_key
    FROM automation_event_queue
    WHERE source = 'event' AND ${freshRow(sql)}
      AND ${queuedEventType(sql)} = 'ask.waiting'
      AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})`
  for (const row of due) {
    const ask = askOfKey(row.ask_key)
    const open = ask === undefined ? undefined : yield* readOpenAsk(sql, ask)
    if (open === undefined) yield* sql`DELETE FROM automation_event_queue WHERE id = ${row.id}`
  }
})

const askRow = (row: AskSqlRow): AskFeedRow => ({
  kind: row.kind,
  key: row.ask_key,
  text: row.text ?? "",
  detail: row.detail ?? undefined,
  toolName: row.tool_name ?? undefined,
  askedAt: row.asked_at,
  chat:
    row.session_id === null || row.public_ref === null
      ? undefined
      : {
          sessionId: row.session_id,
          publicRef: row.public_ref,
          name: row.chat_name ?? undefined,
          spaceName: row.space_name ?? undefined
        },
  producedBy: row.produced_by ?? undefined,
  automationName: row.automation_name ?? undefined,
  chainDepth: causedChainDepth(row.produced_by, row.chain_depth)
})
