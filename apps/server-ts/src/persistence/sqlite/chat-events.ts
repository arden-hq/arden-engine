import { firstLine } from "@arden-hq/std/text"
import { machineTimeZone } from "@arden-hq/std/time"
import { answerSaid, answerWords } from "@arden-hq/protocol/runs"
import { ChatUpdateSchema, CommunicationEnvelopeSchema } from "@arden-hq/protocol/effect/chat"
import { DateTime, Duration, Effect, Option, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import {
  approvalChanges,
  approvalStep,
  arrivalSource,
  chatEventLines,
  chatEventsMessage,
  doorRef,
  type ApprovalAsker,
  type ApprovalEvent,
  type ChatEvent
} from "../transcript/chat-events.js"
import { JsonObjectSchema, type JsonObject } from "../json.js"
import type { StoredMessageEnvelope } from "../transcript/model.js"
import type { ChatWriteError } from "../chat/store.js"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { appendMessagesInTransaction } from "./chat-transcript.js"
import { writeError, type ChatWriteOperation } from "./chat-write-errors.js"
import { communicationToldSql } from "./transcript.js"
import { questionVisiblePredicate } from "./question-events.js"
import { runColumns, runDestinationSessionId } from "./run-destination.js"
import { RUN_END_APPROVAL_FEEDBACK } from "./tool-receipts.js"
import { currentSessionTurnId } from "./turns.js"
import { sessionDescendants } from "./tree-walk.js"
import { sha256Hex } from "@arden-hq/std/hash"
import {
  answeredApprovalStatusList,
  answeredProposalStatusList,
  erroredRunStatusList
} from "./status-sets.js"

const FIRST_LOOK = Duration.days(3)
const LATE_SLACK = Duration.days(2)

type InScope = (item: {
  readonly itemId: string | null
  readonly spaceId: string | null
}) => boolean

interface ChatScope {
  readonly session_type: string
  readonly space_id: string | null
  readonly space_conversation_id: string | null
  readonly checked_at: string | null
}

export interface ChatEventsLook {
  readonly since: string
  readonly batch: ChatEventsBatch | undefined
}

interface ChatEventsBatch {
  readonly message: StoredMessageEnvelope
  readonly keys: ReadonlyArray<string>
}

export const findChatEvents = Effect.fn("SqliteChatEvents.find")(function* (
  sql: SqlClient.SqlClient,
  options: {
    readonly sessionId: string
    readonly now: DateTime.Utc
    readonly timeZone?: string
  }
): Effect.fn.Return<ChatEventsLook | undefined, SqlError> {
  const { sessionId } = options
  const scope = (yield* sql<ChatScope>`SELECT s.session_type, s.space_id,
      conversation.session_id AS space_conversation_id, cursor.checked_at
    FROM sessions AS s
    LEFT JOIN space_conversations AS conversation ON conversation.space_id = s.space_id
    LEFT JOIN chat_event_cursors AS cursor ON cursor.session_id = s.session_id
    WHERE s.session_id = ${sessionId} AND s.archived_at IS NULL`)[0]
  if (scope === undefined || scope.session_type === "agent") return undefined
  const since = DateTime.formatIso(
    scope.checked_at === null
      ? DateTime.subtractDuration(options.now, FIRST_LOOK)
      : DateTime.subtractDuration(DateTime.makeUnsafe(scope.checked_at), LATE_SLACK)
  )
  const spaceHome = scope.space_conversation_id === sessionId ? scope.space_id : null
  const started = new Set(
    spaceHome !== null || scope.space_id === null
      ? []
      : (yield* sql<{ readonly item_id: string }>`SELECT item_id FROM space_tasks
          WHERE home_session_id = ${sessionId}`).map((row) => row.item_id)
  )
  const inScope: InScope = (item) =>
    (spaceHome !== null && item.spaceId === spaceHome) ||
    (item.itemId !== null && started.has(item.itemId))

  const found: ReadonlyArray<ChatEvent> = [
    ...(yield* arrivals(sql, { sessionId, since, scope, spaceHome, inScope })),
    ...(yield* waiting(sql, { sessionId, since, inScope })),
    ...(yield* answers(sql, { sessionId, since, inScope })),
    ...(yield* approvals(sql, { sessionId, since, inScope })),
    ...(yield* proposals(sql, { sessionId, since, spaceHome })),
    ...(yield* focusChoices(sql, { sessionId, since })),
    ...(yield* failedTurns(sql, { sessionId, since }))
  ]
  const delivered = new Set(
    found.length === 0
      ? []
      : (yield* sql<{
          readonly event_key: string
        }>`SELECT event_key FROM chat_event_deliveries AS delivered
          WHERE event_key IN ${sql.in(found.map((event) => event.key))}
            AND (delivered.session_id = ${sessionId} OR EXISTS (
              SELECT 1 FROM session_messages AS inherited
              WHERE inherited.session_id = ${sessionId}
                AND inherited.message_id = delivered.message_id
            ))`).map((row) => row.event_key)
  )
  const fresh = found.filter((event) => !delivered.has(event.key))
  if (fresh.length === 0) return { since, batch: undefined }
  const keys = fresh.map((event) => event.key)
  const digest = sha256Hex(keys.join("\n"))
  const messageId = `chat-events:${digest.slice(0, 32)}`
  const existing = yield* sql`SELECT 1 FROM session_messages
    WHERE session_id = ${sessionId} AND message_id = ${messageId} LIMIT 1`
  if (existing.length > 0) return { since, batch: undefined }
  const lines = chatEventLines(fresh, {
    now: new Date(DateTime.toEpochMillis(options.now)),
    timeZone: options.timeZone ?? machineTimeZone(),
    listTool: scope.space_id === null ? "session_read" : "space_board_read"
  })
  return {
    since,
    batch: {
      message: chatEventsMessage({
        messageId,
        createdAt: DateTime.formatIso(options.now),
        lines
      }),
      keys
    }
  }
})

export const appendChatEventsBeforeTurn = Effect.fn("SqliteChatEvents.beforeTurn")(function* (
  sql: SqlClient.SqlClient,
  options: {
    readonly sessionId: string
    readonly now: DateTime.Utc
  }
): Effect.fn.Return<void, ChatWriteError> {
  const look = yield* findChatEvents(sql, {
    sessionId: options.sessionId,
    now: options.now
  }).pipe(Effect.mapError(lookError("start", options.sessionId)))
  if (look === undefined) return
  yield* appendChatEventsInTransaction(sql, {
    ...options,
    look,
    operation: "start",
    turnId: undefined
  })
})

export const takeChatEventsBeforeQueued = Effect.fn("SqliteChatEvents.beforeQueued")(function* (
  sql: SqlClient.SqlClient,
  options: {
    readonly run: { readonly session_id: string; readonly automation_context_mode: string | null }
    readonly queued: number
    readonly now: DateTime.Utc
    readonly operation: ChatWriteOperation
  }
): Effect.fn.Return<ReadonlyArray<StoredMessageEnvelope>, ChatWriteError> {
  if (options.queued === 0 || options.run.automation_context_mode === "fresh") return []
  const sessionId = options.run.session_id
  const look = yield* findChatEvents(sql, { sessionId, now: options.now }).pipe(
    Effect.mapError(lookError(options.operation, sessionId))
  )
  if (look === undefined) return []
  yield* recordChatEvents(sql, { ...options, sessionId, look })
  return look.batch === undefined ? [] : [look.batch.message]
})

const recordChatEvents = Effect.fn("SqliteChatEvents.record")(function* (
  sql: SqlClient.SqlClient,
  options: {
    readonly sessionId: string
    readonly look: ChatEventsLook
    readonly now: DateTime.Utc
    readonly operation: ChatWriteOperation
  }
): Effect.fn.Return<void, ChatWriteError> {
  const { sessionId } = options
  const nowIso = DateTime.formatIso(options.now)
  const batch = options.look.batch
  yield* Effect.gen(function* () {
    yield* sql`INSERT INTO chat_event_cursors (session_id, checked_at) VALUES (${sessionId}, ${nowIso})
      ON CONFLICT(session_id) DO UPDATE SET checked_at = MAX(checked_at, excluded.checked_at)`
    yield* sql`DELETE FROM chat_event_deliveries
      WHERE session_id = ${sessionId} AND delivered_at < ${options.look.since}`
    if (batch === undefined) return
    for (const key of batch.keys) {
      yield* sql`INSERT INTO chat_event_deliveries (session_id, event_key, message_id, delivered_at)
        VALUES (${sessionId}, ${key}, ${batch.message.message_id}, ${nowIso})`
    }
  }).pipe(
    Effect.mapError((cause) =>
      writeError(options.operation, "storage", "Could not record chat events", {
        sessionId,
        cause
      })
    )
  )
})

export const lookError =
  (operation: ChatWriteOperation, sessionId: string) =>
  (cause: unknown): ChatWriteError =>
    writeError(operation, "storage", "Could not read chat events", { sessionId, cause })

export const appendChatEventsInTransaction = Effect.fn("SqliteChatEvents.append")(function* (
  sql: SqlClient.SqlClient,
  options: {
    readonly sessionId: string
    readonly look: ChatEventsLook
    readonly now: DateTime.Utc
    readonly operation: ChatWriteOperation
    readonly turnId: string | undefined
  }
): Effect.fn.Return<void, ChatWriteError> {
  const { sessionId } = options
  const batch = options.look.batch
  yield* recordChatEvents(sql, options)
  if (batch === undefined) return
  const turnId =
    options.turnId ??
    (yield* currentSessionTurnId(sql, sessionId).pipe(
      Effect.mapError((cause) =>
        writeError(options.operation, "storage", "Could not read the chat's newest turn", {
          sessionId,
          cause
        })
      )
    )) ??
    batch.message.message_id
  yield* appendMessagesInTransaction(
    sql,
    sessionId,
    [batch.message],
    DateTime.formatIso(options.now),
    options.operation,
    turnId
  )
})

const decodeCommunication = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ communication: CommunicationEnvelopeSchema }))
)
const decodeUpdate = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ update: ChatUpdateSchema }))
)

const arrivals = Effect.fn("SqliteChatEvents.arrivals")(function* (
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
    LEFT JOIN space_tasks AS task
      ON task.item_id = COALESCE(json_extract(m.message_json, '$.communication.arrival.door.item_id'),
        json_extract(m.message_json, '$.update.door.item_id'))
    WHERE m.session_id IN ${sql.in(sessions)}
      AND m.message_id >= 'arrival:' AND m.message_id < 'arrival;'
      AND (${communicationToldSql(sql)} OR (m.session_id <> ${options.sessionId}
        AND json_type(m.message_json, '$.update') = 'object'))
      AND m.created_at > ${options.since}`
  return rows.flatMap((row): ReadonlyArray<ChatEvent> => {
    if (row.source_session_id === options.sessionId || row.source_purpose === "system") return []
    const told = arrivalTold(row.message_json)
    if (told === undefined) return []
    const { event, door, line } = told
    const itemId = door.kind === "task" || door.kind === "artifact" ? door.item_id : null
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
    if (arrival.event === "needs_you") return undefined
    return { ...arrival, subject: arrival.source_session_ref }
  }
  const update = decodeUpdate(messageJson)
  return Option.isSome(update) ? { ...update.value.update, subject: undefined } : undefined
}

const waiting = Effect.fn("SqliteChatEvents.waiting")(function* (
  sql: SqlClient.SqlClient,
  options: {
    readonly sessionId: string
    readonly since: string
    readonly inScope: InScope
  }
) {
  const questionRows = yield* sql<{
    readonly question_id: string
    readonly content: string
    readonly created_at: string
    readonly item_id: string | null
    readonly task_space_id: string | null
    readonly task_text: string | null
    readonly stable_key: string | null
    readonly automation_name: string | null
    readonly asking_type: string
    readonly asking_name: string | null
    readonly asking_ref: string
    readonly destination_session_id: string | null
  }>`SELECT question.question_id, question.content, question.created_at,
      task.item_id, task.space_id AS task_space_id, task.text AS task_text, task.stable_key,
      job.name AS automation_name, asking.session_type AS asking_type,
      asking.name AS asking_name, asking.public_ref AS asking_ref,
      ${runDestinationSessionId(sql, runColumns(sql, "run"))}
        AS destination_session_id
    FROM run_questions AS question
    JOIN chat_runs AS run ON run.run_id = question.run_id
    JOIN sessions AS asking ON asking.session_id = run.session_id
    LEFT JOIN scheduled_tasks AS job ON job.task_id = asking.origin_automation_id
    LEFT JOIN space_tasks AS task
      ON task.item_id = json_extract(run.metadata_json, '$.run_context.task.item_id')
    WHERE ${questionVisiblePredicate({
      sql,
      run: runColumns(sql, "run"),
      resolution: sql`question.resolution`,
      closedAt: sql`question.closed_at`
    })}
      AND question.created_at > ${options.since}
      AND run.session_id <> ${options.sessionId}
      AND COALESCE(job.purpose, '') <> 'system'
      AND NOT EXISTS (SELECT 1 FROM focus_choices WHERE question_id = question.question_id)`
  const approvalRows = yield* sql<{
    readonly run_id: string
    readonly tool_call_id: string
    readonly tool_name: string
    readonly preview: string | null
    readonly requested_at: string
    readonly payload_json: string
    readonly item_id: string | null
    readonly task_space_id: string | null
    readonly task_text: string | null
    readonly stable_key: string | null
    readonly automation_name: string | null
    readonly asking_type: string
    readonly asking_name: string | null
    readonly asking_ref: string
    readonly destination_session_id: string | null
  }>`SELECT approval.run_id, approval.tool_call_id, approval.tool_name, approval.preview,
      approval.requested_at, approval.payload_json,
      task.item_id, task.space_id AS task_space_id, task.text AS task_text, task.stable_key,
      job.name AS automation_name, asking.session_type AS asking_type,
      asking.name AS asking_name, asking.public_ref AS asking_ref,
      ${runDestinationSessionId(sql, runColumns(sql, "run"))}
        AS destination_session_id
    FROM tool_approvals AS approval
    JOIN chat_runs AS run ON run.run_id = approval.run_id
    JOIN sessions AS asking ON asking.session_id = approval.session_id
    LEFT JOIN scheduled_tasks AS job ON job.task_id = asking.origin_automation_id
    LEFT JOIN space_tasks AS task
      ON task.item_id = json_extract(run.metadata_json, '$.run_context.task.item_id')
    WHERE approval.kind = 'tool_approval' AND approval.status = 'pending'
      AND approval.action <> 'connection'
      AND approval.requested_at > ${options.since}
      AND approval.session_id <> ${options.sessionId}
      AND COALESCE(job.purpose, '') <> 'system'`
  const here = (row: {
    readonly destination_session_id: string | null
    readonly item_id: string | null
    readonly task_space_id: string | null
  }): boolean =>
    row.destination_session_id === options.sessionId ||
    options.inScope({ itemId: row.item_id, spaceId: row.task_space_id })
  const refOf = (row: { readonly stable_key: string | null; readonly asking_ref: string }) =>
    row.stable_key === null ? `session:${row.asking_ref}` : `task:${row.stable_key}`
  const asked = questionRows.flatMap((row): ReadonlyArray<ChatEvent> => {
    if (!here(row)) return []
    const question = Schema.decodeUnknownOption(QuestionSchema)(row.content)
    if (Option.isNone(question)) return []
    return [
      {
        kind: "waiting",
        key: `waiting:${row.question_id}`,
        at: row.created_at,
        asker: approvalAsker(row),
        what: { kind: "question", prompt: question.value.prompt },
        ref: refOf(row)
      }
    ]
  })
  const approved = approvalRows.flatMap((row): ReadonlyArray<ChatEvent> => {
    if (!here(row)) return []
    const payload = Option.getOrUndefined(
      Schema.decodeUnknownOption(ApprovalPayloadSchema)(row.payload_json)
    )
    return [
      {
        kind: "waiting",
        key: `waiting:${row.run_id}:${row.tool_call_id}`,
        at: row.requested_at,
        asker: approvalAsker(row),
        what: {
          kind: "approval",
          step: approvalStep(
            row.tool_name,
            payload?.description ??
              row.preview ??
              payload?.presentation?.body?.text ??
              payload?.presentation?.title
          )
        },
        ref: refOf(row)
      }
    ]
  })
  return [...asked, ...approved]
})

const QuestionSchema = Schema.fromJsonString(
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

const answers = Effect.fn("SqliteChatEvents.answers")(function* (
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
    const parts = answerSaid(question.value.choices, resolution.value.answer)
    const said = parts === undefined ? undefined : answerWords(parts)
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

const ApprovalPayloadSchema = Schema.fromJsonString(
  Schema.Struct({
    description: Schema.optionalKey(Schema.String),
    presentation: Schema.optionalKey(
      Schema.Struct({
        title: Schema.String,
        body: Schema.optionalKey(Schema.Struct({ text: Schema.String }))
      })
    )
  })
)
const ApprovalResolutionSchema = Schema.fromJsonString(
  Schema.Struct({
    approved: Schema.Boolean,
    feedback: Schema.NullOr(Schema.String),
    edited_arguments: Schema.optionalKey(JsonObjectSchema),
    alternative: Schema.optionalKey(Schema.Literal("draft"))
  })
)
const decodeArguments = Schema.decodeUnknownOption(Schema.fromJsonString(JsonObjectSchema))

const approvals = Effect.fn("SqliteChatEvents.approvals")(function* (
  sql: SqlClient.SqlClient,
  options: {
    readonly sessionId: string
    readonly since: string
    readonly inScope: InScope
  }
) {
  const rows = yield* sql<{
    readonly run_id: string
    readonly tool_call_id: string
    readonly tool_name: string
    readonly preview: string | null
    readonly resolved_at: string
    readonly resolution_json: string
    readonly payload_json: string
    readonly arguments_json: string
    readonly asking_session_id: string
    readonly asking_name: string | null
    readonly asking_type: string
    readonly asking_ref: string
    readonly automation_name: string | null
    readonly item_id: string | null
    readonly task_space_id: string | null
    readonly task_text: string | null
    readonly stable_key: string | null
    readonly destination_session_id: string | null
  }>`SELECT approval.run_id, approval.tool_call_id, approval.tool_name, approval.preview,
      approval.resolved_at, approval.resolution_json, approval.payload_json,
      tool.arguments_json, asking.session_id AS asking_session_id, asking.name AS asking_name,
      asking.session_type AS asking_type, asking.public_ref AS asking_ref,
      job.name AS automation_name, task.item_id, task.space_id AS task_space_id,
      task.text AS task_text, task.stable_key,
      ${runDestinationSessionId(sql, runColumns(sql, "run"))}
        AS destination_session_id
    FROM tool_approvals AS approval
    JOIN chat_runs AS run ON run.run_id = approval.run_id
    JOIN tool_calls AS tool
      ON tool.run_id = approval.run_id AND tool.tool_call_id = approval.tool_call_id
    JOIN sessions AS asking ON asking.session_id = approval.session_id
    LEFT JOIN scheduled_tasks AS job ON job.task_id = asking.origin_automation_id
    LEFT JOIN space_tasks AS task
      ON task.item_id = json_extract(run.metadata_json, '$.run_context.task.item_id')
    WHERE approval.kind = 'tool_approval' AND approval.status IN ${answeredApprovalStatusList}
      AND approval.action <> 'connection'
      AND approval.resolved_at > ${options.since}
      AND approval.session_id <> ${options.sessionId}
      AND COALESCE(job.purpose, '') <> 'system'
      AND COALESCE(approval.result_feedback, '')
        NOT IN ${sql.in(Object.values(RUN_END_APPROVAL_FEEDBACK))}`
  if (rows.length === 0) return []
  const children = new Set(
    (yield* sql<{ readonly session_id: string }>`WITH RECURSIVE ${sessionDescendants(sql, {
      name: "family",
      from: sql`SELECT session_id FROM sessions WHERE parent_session_id = ${options.sessionId}`
    })}
      SELECT session_id FROM family`).map((row) => row.session_id)
  )
  return rows.flatMap((row): ReadonlyArray<ChatEvent> => {
    if (
      row.destination_session_id !== options.sessionId &&
      !children.has(row.asking_session_id) &&
      !options.inScope({ itemId: row.item_id, spaceId: row.task_space_id })
    )
      return []
    const resolution = Schema.decodeUnknownOption(ApprovalResolutionSchema)(row.resolution_json)
    if (Option.isNone(resolution)) return []
    const payload = Option.getOrUndefined(
      Schema.decodeUnknownOption(ApprovalPayloadSchema)(row.payload_json)
    )
    const edited = resolution.value.edited_arguments
    const requested = Option.getOrUndefined(decodeArguments(row.arguments_json))
    const feedback = resolution.value.feedback?.trim()
    return [
      {
        kind: "approval",
        key: `approval:${row.run_id}:${row.tool_call_id}`,
        at: row.resolved_at,
        decision:
          resolution.value.alternative === "draft"
            ? { kind: "drafted" }
            : approvalDecision(resolution.value.approved, feedback, requested, edited),
        step: approvalStep(
          row.tool_name,
          payload?.description ??
            row.preview ??
            payload?.presentation?.body?.text ??
            payload?.presentation?.title
        ),
        asker: approvalAsker(row),
        ref: row.stable_key !== null ? `task:${row.stable_key}` : `session:${row.asking_ref}`
      }
    ]
  })
})

const approvalDecision = (
  approved: boolean,
  feedback: string | undefined,
  requested: JsonObject | undefined,
  edited: JsonObject | undefined
): ApprovalEvent["decision"] => {
  if (!approved) return { kind: "rejected", reason: feedback === "" ? undefined : feedback }
  if (edited === undefined || requested === undefined) return { kind: "approved" }
  return { kind: "edited", changes: approvalChanges(requested, edited) }
}

const approvalAsker = (row: {
  readonly task_text: string | null
  readonly automation_name: string | null
  readonly asking_type: string
  readonly asking_name: string | null
}): ApprovalAsker => {
  if (row.task_text !== null) return { kind: "Task", name: row.task_text }
  if (row.automation_name !== null && row.automation_name.trim() !== "")
    return { kind: "automation", name: row.automation_name }
  const name = row.asking_name?.trim() || "untitled"
  return row.asking_type === "agent" ? { kind: "agent", name } : { kind: "chat", name }
}

const proposals = Effect.fn("SqliteChatEvents.proposals")(function* (
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
    decision: row.status === "accepted" ? "started" : "skipped",
    text: row.text,
    ref: row.stable_key === null ? undefined : `task:${row.stable_key}`
  }))
})

const focusChoices = Effect.fn("SqliteChatEvents.focusChoices")(function* (
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
      row.decision === "continue_here" || row.result_session_id === options.sessionId
        ? { kind: "here" }
        : {
            kind: "moved",
            name: row.name?.trim() || "another chat",
            ref: `session:${row.public_ref}`
          }
  }))
})

const failedTurns = Effect.fn("SqliteChatEvents.failedTurns")(function* (
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
