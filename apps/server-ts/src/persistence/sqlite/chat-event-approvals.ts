import { TOOL_APPROVAL_ALTERNATIVE } from "@arden-hq/protocol/chat"
import { SESSION_TYPE } from "@arden-hq/protocol/sessions"
import { Effect, Option, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import {
  approvalChanges,
  approvalStep,
  type ApprovalAsker,
  type ApprovalEvent,
  type ChatEvent
} from "../transcript/chat-events.js"
import { JsonObjectSchema, type JsonObject } from "../json.js"
import { questionVisiblePredicate } from "./question-events.js"
import { runColumns, runDestinationSessionId } from "./run-destination.js"
import { RUN_END_APPROVAL_FEEDBACK } from "./tool-receipts.js"
import { sessionDescendants } from "./tree-walk.js"
import { reviewNameSql } from "./automation-rows.js"
import { answeredApprovalStatusList } from "./status-sets.js"
import { type InScope, askingOwnerJoin, QuestionSchema } from "./chat-event-sources.js"

export const waiting = Effect.fn("SqliteChatEvents.waiting")(function* (
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
      COALESCE(job.name, ${reviewNameSql(sql, "review_space")}) AS automation_name, asking.session_type AS asking_type,
      asking.name AS asking_name, asking.public_ref AS asking_ref,
      ${runDestinationSessionId(sql, runColumns(sql, "run"))}
        AS destination_session_id
    FROM run_questions AS question
    JOIN chat_runs AS run ON run.run_id = question.run_id
    JOIN sessions AS asking ON asking.session_id = run.session_id
    ${askingOwnerJoin(sql)}
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
      COALESCE(job.name, ${reviewNameSql(sql, "review_space")}) AS automation_name, asking.session_type AS asking_type,
      asking.name AS asking_name, asking.public_ref AS asking_ref,
      ${runDestinationSessionId(sql, runColumns(sql, "run"))}
        AS destination_session_id
    FROM tool_approvals AS approval
    JOIN chat_runs AS run ON run.run_id = approval.run_id
    JOIN sessions AS asking ON asking.session_id = approval.session_id
    ${askingOwnerJoin(sql)}
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
    alternative: Schema.optionalKey(Schema.Literal(TOOL_APPROVAL_ALTERNATIVE.draft))
  })
)
const decodeArguments = Schema.decodeUnknownOption(Schema.fromJsonString(JsonObjectSchema))

export const approvals = Effect.fn("SqliteChatEvents.approvals")(function* (
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
      COALESCE(job.name, ${reviewNameSql(sql, "review_space")}) AS automation_name, task.item_id, task.space_id AS task_space_id,
      task.text AS task_text, task.stable_key,
      ${runDestinationSessionId(sql, runColumns(sql, "run"))}
        AS destination_session_id
    FROM tool_approvals AS approval
    JOIN chat_runs AS run ON run.run_id = approval.run_id
    JOIN tool_calls AS tool
      ON tool.run_id = approval.run_id AND tool.tool_call_id = approval.tool_call_id
    JOIN sessions AS asking ON asking.session_id = approval.session_id
    ${askingOwnerJoin(sql)}
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
          resolution.value.alternative === TOOL_APPROVAL_ALTERNATIVE.draft
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
  return row.asking_type === SESSION_TYPE.agent ? { kind: "agent", name } : { kind: "chat", name }
}
