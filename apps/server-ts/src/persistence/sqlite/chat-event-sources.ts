import { JOB_PURPOSE } from "../job-classification.js"
import { TASK_PROPOSAL_STATUS } from "@arden-hq/protocol/proposals"
import { FOCUS_CHOICE_DECISION } from "@arden-hq/protocol/sessions/focus-choices"
import { ARRIVAL_EVENT, COMMUNICATION_DOOR } from "@arden-hq/protocol/chat"
import { firstLine } from "@arden-hq/std/text"
import { storedAnswerWords } from "../runs/stored-question.js"
import { ChatUpdateSchema, CommunicationEnvelopeSchema } from "@arden-hq/protocol/effect/chat"
import { Effect, Option, Schema } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import { arrivalSource, doorRef, type ChatEvent } from "../transcript/chat-events.js"
import { runColumns, runDestinationSessionId } from "./run-destination.js"
import { reviewSpaceIdSql } from "./automation-rows.js"
import { answeredProposalStatusList, erroredRunStatusList } from "./status-sets.js"
import { communicationToldSql, ownMessagePredicate } from "./transcript-predicates.js"

export const askingOwnerJoin = (sql: SqlClient.SqlClient): Statement.Fragment => sql`
    LEFT JOIN scheduled_tasks AS job ON job.task_id = asking.origin_automation_id
      AND job.purpose != 'space_review'
    LEFT JOIN spaces AS review_space
      ON review_space.space_id = ${reviewSpaceIdSql(sql, sql`asking.origin_automation_id`)}`

export type InScope = (item: {
  readonly itemId: string | null
  readonly spaceId: string | null
}) => boolean

export interface ChatScope {
  readonly session_type: string
  readonly space_id: string | null
  readonly space_conversation_id: string | null
  readonly checked_at: string | null
}

const decodeCommunication = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ communication: CommunicationEnvelopeSchema }))
)
const decodeUpdate = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ update: ChatUpdateSchema }))
)

export const arrivals = Effect.fn("SqliteChatEvents.arrivals")(function* (
  sql: SqlClient.SqlClient,
  options: {
    readonly sessionId: string
    readonly since: string
    readonly scope: ChatScope
    readonly spaceHome: string | null
    readonly inScope: InScope
  }
) {
  const home = options.scope.space_conversation_id
  const spaceChats =
    options.spaceHome === null
      ? []
      : (yield* sql<{ readonly session_id: string }>`SELECT session_id FROM sessions
          WHERE space_id = ${options.spaceHome} AND session_id <> ${options.sessionId}
            AND session_type IN ('chat', 'channel')`).map((row) => row.session_id)
  const mirrored = new Set(spaceChats)
  const others = options.spaceHome === null && home !== null ? [home] : spaceChats
  const sessions = [options.sessionId, ...others]
  const rows = yield* sql<{
    readonly session_id: string
    readonly message_id: string
    readonly created_at: string
    readonly message_json: string
    readonly source_session_id: string | null
    readonly source_purpose: string | null
    readonly stable_key: string | null
  }>`SELECT m.session_id, m.message_id, m.created_at, m.message_json,
      source_run.session_id AS source_session_id, job.purpose AS source_purpose,
      task.stable_key
    FROM session_messages AS m
    LEFT JOIN chat_runs AS source_run
      ON source_run.run_id = json_extract(m.message_json, '$.communication.arrival.source_run_id')
    LEFT JOIN sessions AS source ON source.session_id = source_run.session_id
    LEFT JOIN scheduled_tasks AS job ON job.task_id = source.origin_automation_id
      AND job.purpose != 'space_review'
    LEFT JOIN space_tasks AS task
      ON task.item_id = COALESCE(json_extract(m.message_json, '$.communication.arrival.door.item_id'),
        json_extract(m.message_json, '$.update.door.item_id'))
    WHERE m.session_id IN ${sql.in(sessions)}
      AND m.message_id >= 'arrival:' AND m.message_id < 'arrival;'
      AND (${communicationToldSql(sql)} OR (m.session_id <> ${options.sessionId}
        AND json_type(m.message_json, '$.update') = 'object'))
      -- A fork copies its parent's arrivals and keeps their ids. Only the chat an arrival
      -- came to counts, or each fork would tell the Space's main chat about it again.
      AND (m.session_id = ${options.sessionId} OR ${ownMessagePredicate(sql)})
      AND m.created_at > ${options.since}`
  return rows.flatMap((row): ReadonlyArray<ChatEvent> => {
    if (row.source_session_id === options.sessionId || row.source_purpose === JOB_PURPOSE.system)
      return []
    const told = arrivalTold(row.message_json)
    if (told === undefined) return []
    const { event, door, line } = told
    const itemId =
      door.kind === COMMUNICATION_DOOR.task || door.kind === COMMUNICATION_DOOR.artifact
        ? door.item_id
        : null
    if (
      row.session_id !== options.sessionId &&
      !mirrored.has(row.session_id) &&
      !options.inScope({ itemId, spaceId: null })
    )
      return []
    const ref = doorRef(door, row.stable_key)
    return [
      {
        kind: "arrival",
        key: row.message_id,
        at: row.created_at,
        event,
        source: arrivalSource(door),
        name: door.label,
        line,
        subject: itemId ?? told.subject ?? ref,
        ref
      }
    ]
  })
})

const arrivalTold = (messageJson: string) => {
  const communication = decodeCommunication(messageJson)
  if (Option.isSome(communication)) {
    const arrival = communication.value.communication.arrival
    if (arrival.event === ARRIVAL_EVENT.needsYou) return undefined
    return { ...arrival, subject: arrival.source_session_ref }
  }
  const update = decodeUpdate(messageJson)
  return Option.isSome(update) ? { ...update.value.update, subject: undefined } : undefined
}

export const QuestionSchema = Schema.fromJsonString(
  Schema.Struct({
    prompt: Schema.String,
    choices: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String }))
  })
)
const ResolutionSchema = Schema.fromJsonString(
  Schema.Struct({
    answer: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String }),
      Schema.Struct({ kind: Schema.Literal("choice"), choice_id: Schema.String }),
      Schema.Struct({
        kind: Schema.Literal("choices"),
        choice_ids: Schema.Array(Schema.String),
        text: Schema.optionalKey(Schema.String)
      }),
      Schema.Struct({ kind: Schema.Literal("hold") })
    ]),
    resolved_at: Schema.String
  })
)

export const answers = Effect.fn("SqliteChatEvents.answers")(function* (
  sql: SqlClient.SqlClient,
  options: {
    readonly sessionId: string
    readonly since: string
    readonly inScope: InScope
  }
) {
  const rows = yield* sql<{
    readonly question_id: string
    readonly content: string
    readonly resolution: string
    readonly item_id: string | null
    readonly task_space_id: string | null
    readonly stable_key: string | null
    readonly destination_session_id: string | null
  }>`SELECT question.question_id, question.content, question.resolution,
      task.item_id, task.space_id AS task_space_id, task.stable_key,
      ${runDestinationSessionId(sql, runColumns(sql, "run"))}
        AS destination_session_id
    FROM run_questions AS question
    JOIN chat_runs AS run ON run.run_id = question.run_id
    LEFT JOIN space_tasks AS task
      ON task.item_id = json_extract(run.metadata_json, '$.run_context.task.item_id')
    WHERE question.resolution IS NOT NULL
      AND json_extract(question.resolution, '$.resolved_at') > ${options.since}
      AND run.session_id <> ${options.sessionId}
      AND NOT EXISTS (SELECT 1 FROM focus_choices WHERE question_id = question.question_id)`
  return rows.flatMap((row): ReadonlyArray<ChatEvent> => {
    if (
      row.destination_session_id !== options.sessionId &&
      !options.inScope({ itemId: row.item_id, spaceId: row.task_space_id })
    )
      return []
    const question = Schema.decodeUnknownOption(QuestionSchema)(row.content)
    const resolution = Schema.decodeUnknownOption(ResolutionSchema)(row.resolution)
    if (Option.isNone(question) || Option.isNone(resolution)) return []
    const said = storedAnswerWords(question.value.choices, resolution.value.answer)
    return [
      {
        kind: "answer",
        key: `answer:${row.question_id}`,
        at: resolution.value.resolved_at,
        prompt: question.value.prompt,
        answer: said === undefined ? { kind: "hold" } : { kind: "said", text: said },
        ref: row.stable_key === null ? undefined : `task:${row.stable_key}`
      }
    ]
  })
})

export const proposals = Effect.fn("SqliteChatEvents.proposals")(function* (
  sql: SqlClient.SqlClient,
  options: { readonly sessionId: string; readonly since: string; readonly spaceHome: string | null }
) {
  const rows = yield* sql<{
    readonly proposal_id: string
    readonly status: string
    readonly text: string
    readonly settled_at: string
    readonly stable_key: string | null
  }>`SELECT proposal.proposal_id, proposal.status, proposal.text, proposal.settled_at,
      task.stable_key
    FROM task_proposals AS proposal
    LEFT JOIN space_tasks AS task ON task.item_id = proposal.item_id
    WHERE proposal.status IN ${answeredProposalStatusList}
      AND proposal.settled_at > ${options.since}
      AND (proposal.source_session_id = ${options.sessionId}
        OR proposal.space_id = ${options.spaceHome})`
  return rows.map((row): ChatEvent => ({
    kind: "proposal",
    key: `proposal:${row.proposal_id}`,
    at: row.settled_at,
    decision: row.status === TASK_PROPOSAL_STATUS.accepted ? "started" : "skipped",
    text: row.text,
    ref: row.stable_key === null ? undefined : `task:${row.stable_key}`
  }))
})

export const focusChoices = Effect.fn("SqliteChatEvents.focusChoices")(function* (
  sql: SqlClient.SqlClient,
  options: { readonly sessionId: string; readonly since: string }
) {
  const rows = yield* sql<{
    readonly choice_id: string
    readonly decision: string
    readonly settled_at: string
    readonly result_session_id: string
    readonly name: string | null
    readonly public_ref: string
  }>`SELECT choice.choice_id, choice.decision, choice.settled_at, choice.result_session_id,
      target.name, target.public_ref
    FROM focus_choices AS choice
    JOIN sessions AS target ON target.session_id = choice.result_session_id
    WHERE choice.status = 'settled' AND choice.source_session_id = ${options.sessionId}
      AND choice.settled_at > ${options.since}`
  return rows.map((row): ChatEvent => ({
    kind: "focus",
    key: `focus:${row.choice_id}`,
    at: row.settled_at,
    decision:
      row.decision === FOCUS_CHOICE_DECISION.continueHere ||
      row.result_session_id === options.sessionId
        ? { kind: "here" }
        : {
            kind: "moved",
            name: row.name?.trim() || "another chat",
            ref: `session:${row.public_ref}`
          }
  }))
})

export const failedTurns = Effect.fn("SqliteChatEvents.failedTurns")(function* (
  sql: SqlClient.SqlClient,
  options: { readonly sessionId: string; readonly since: string }
) {
  const rows = yield* sql<{
    readonly run_id: string
    readonly error_code: string | null
    readonly error_message: string | null
    readonly ended_at: string
  }>`SELECT run_id, error_code, error_message, ended_at FROM chat_runs
    WHERE session_id = ${options.sessionId} AND status IN ${erroredRunStatusList}
      AND ended_at > ${options.since}`
  return rows.map((row): ChatEvent => ({
    kind: "failed_turn",
    key: `failed:${row.run_id}`,
    at: row.ended_at,
    reason: plainReason(row.error_message, row.error_code),
    runId: row.run_id
  }))
})

const plainReason = (message: string | null, code: string | null): string => {
  const quoted = message?.match(/"message":\s*"((?:[^"\\]|\\.)*)"/)?.[1]
  const line = firstLine(quoted ?? message ?? "")
  return line.length > 0 ? line : (code ?? "the run failed")
}
