import { jobHeldSince } from "./automation-running.js"
import { taskStandsSql } from "./task-wake.js"
import { AutomationToolScopeSchema } from "@arden-hq/protocol/effect/automations"
import { Schema } from "effect"
import { AutomationId } from "../automations/model.js"
import {
  AutomationSubjectSchema,
  SpaceId,
  SpaceReviewSubjectSchema,
  TaskSubjectSchema
} from "../space-job-id.js"
import type { SqlClient, Statement } from "effect/unstable/sql"

export const ContextModeSchema = Schema.Literals(["fresh", "continue", "fork"])

const AuthoredConfigSchema = Schema.Struct({
  ref: Schema.String,
  name: Schema.String,
  prompt: Schema.String,
  model: Schema.NullOr(Schema.String),
  contextMode: ContextModeSchema,
  chatId: Schema.NullOr(Schema.String),
  chatOrigin: Schema.NullOr(Schema.String),
  handler: Schema.NullOr(Schema.String),
  triggers: Schema.String,
  cooldownMinutes: Schema.NullOr(Schema.Number),
  instructionRevisionId: Schema.NullOr(Schema.Number)
})

const DefinitionPolicySchema = Schema.Struct({
  toolScope: AutomationToolScopeSchema,
  autoApprove: Schema.Boolean
})

const DefinitionStateSchema = Schema.Struct({
  enabled: Schema.Boolean,
  heldSince: Schema.NullOr(Schema.String),
  nextRunAt: Schema.NullOr(Schema.String),
  lastRunAt: Schema.NullOr(Schema.String),
  lastResult: Schema.NullOr(Schema.String)
})

const AutomationOwnerSchema = Schema.Struct({
  ...AutomationSubjectSchema.fields,
  key: AutomationId,
  purpose: Schema.Literals(["user_automation", "system"]),
  authored: AuthoredConfigSchema,
  policy: DefinitionPolicySchema,
  state: DefinitionStateSchema
})

const ReviewSettingsSchema = Schema.Struct({
  model: Schema.NullOr(Schema.String),
  contextMode: ContextModeSchema,
  cooldownMinutes: Schema.NullOr(Schema.Number)
})

const SpaceReviewOwnerSchema = Schema.Struct({
  ...SpaceReviewSubjectSchema.fields,
  key: AutomationId,
  name: Schema.String,
  settings: ReviewSettingsSchema,
  chatId: Schema.NullOr(Schema.String),
  mayRun: Schema.Boolean
})

const TaskOwnerSchema = Schema.Struct({
  ...TaskSubjectSchema.fields,
  key: AutomationId,
  spaceId: Schema.NullOr(SpaceId),
  text: Schema.String,
  stands: Schema.Boolean,
  chatId: Schema.NullOr(Schema.String)
})

export const WorkOwnerSchema = Schema.Union([
  AutomationOwnerSchema,
  SpaceReviewOwnerSchema,
  TaskOwnerSchema
])

export type WorkOwner = typeof WorkOwnerSchema.Type

export type DefinitionOwner = Extract<WorkOwner, { readonly kind: "automation" }>

export const ownerJoin = (
  sql: SqlClient.SqlClient,
  key: Statement.Fragment = sql`queue.task_id`
): Statement.Fragment => sql`
  LEFT JOIN scheduled_tasks AS task
    ON task.task_id = ${key} AND task.purpose IN ('user_automation', 'system')
  LEFT JOIN space_tasks AS item
    ON task.task_id IS NULL AND substr(${key}, 1, 5) = 'task:'
      AND item.item_id = substr(${key}, 6)
  LEFT JOIN spaces AS review_space
    ON task.task_id IS NULL AND review_space.space_id = ${reviewSpaceIdSql(sql, key)}`

export const hasOwner = (sql: SqlClient.SqlClient): Statement.Fragment =>
  sql`(task.task_id IS NOT NULL OR item.item_id IS NOT NULL OR review_space.space_id IS NOT NULL)`

export const reviewSpaceIdSql = (
  sql: SqlClient.SqlClient,
  key: Statement.Fragment
): Statement.Fragment => sql`CASE WHEN substr(${key}, 1, 6) = 'space:' THEN substr(${key}, 7) END`

export const reviewNameSql = (sql: SqlClient.SqlClient, space: string): Statement.Fragment =>
  sql`${sql.literal(space)}.name || ' worker'`

const jsonBool = (sql: SqlClient.SqlClient, value: Statement.Fragment): Statement.Fragment =>
  sql`json(CASE WHEN ${value} THEN 'true' ELSE 'false' END)`

export const ownerJson = (
  sql: SqlClient.SqlClient,
  key: Statement.Fragment = sql`queue.task_id`
): Statement.Fragment => {
  return sql`CASE
  WHEN task.task_id IS NOT NULL THEN json_object(
    'kind', 'automation', 'key', task.task_id, 'automationId', task.task_id,
    'purpose', task.purpose,
    'authored', json_object(
      'ref', task.automation_ref, 'name', task.name, 'prompt', task.prompt, 'model', task.model,
      'contextMode', task.context_mode, 'chatId', task.thread_id,
      'chatOrigin', (SELECT set_chat.origin_automation_id FROM sessions AS set_chat
        WHERE set_chat.session_id = task.thread_id),
      'handler', task.handler, 'triggers', task.triggers,
      'cooldownMinutes', task.cooldown_minutes,
      'instructionRevisionId', task.instruction_revision_id),
    'policy', json_object('toolScope', task.tool_scope,
      'autoApprove', ${jsonBool(sql, sql`task.auto_approve = 1`)}),
    'state', json_object('enabled', ${jsonBool(sql, sql`task.enabled = 1`)},
      'heldSince', ${jobHeldSince(sql, "task")}, 'nextRunAt', task.next_run_at,
      'lastRunAt', task.last_run_at, 'lastResult', task.last_result))
  WHEN item.item_id IS NOT NULL THEN json_object(
    'kind', 'task', 'key', ${key}, 'itemId', item.item_id, 'spaceId', item.space_id,
    'text', item.text, 'stands', ${jsonBool(sql, taskStandsSql(sql, "item"))},
    'chatId', (SELECT own.session_id FROM sessions AS own
      WHERE own.origin_automation_id = ${key} AND own.session_type = 'channel'
        AND own.archived_at IS NULL
      ORDER BY own.started_at, own.session_id LIMIT 1))
  WHEN review_space.space_id IS NOT NULL THEN json_object(
    'kind', 'space_review', 'key', ${key}, 'spaceId', review_space.space_id,
    'name', ${reviewNameSql(sql, "review_space")},
    'settings', json((SELECT json_object('model', set_review.model,
        'contextMode', COALESCE(set_review.context_mode, 'fresh'),
        'cooldownMinutes', set_review.cooldown_minutes)
      FROM (SELECT 1) LEFT JOIN space_review_settings AS set_review
        ON set_review.space_id = review_space.space_id)),
    'chatId', (SELECT review_chat.session_id FROM space_review_chats AS review_chat
      WHERE review_chat.space_id = review_space.space_id),
    'mayRun', ${jsonBool(sql, reviewMayRunSql(sql, "review_space"))})
END`
}

export const reviewMayRunSql = (sql: SqlClient.SqlClient, space: string): Statement.Fragment => {
  const row = sql.literal(space)
  return sql`(json_extract(${row}.inference_policy, '$.enabled') = 1
    AND ${row}.page_path IS NOT NULL AND ${row}.archived_at IS NULL)`
}
