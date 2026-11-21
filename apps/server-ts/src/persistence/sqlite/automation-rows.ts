import { jobHeldSince, openRunSince } from "./automation-running.js"
import { taskStandsSql } from "./task-wake.js"
import { countsAsRun } from "./automation-skip-record.js"
import { outcomeSql, shownRunStatus } from "./automation-run-outcome.js"
import { QueueContextSchema, type QueueContext } from "./automation-queue-context.js"
import type {
  Automation,
  AutomationContextMode,
  AutomationToolScope
} from "@arden-hq/protocol/automations"
import { AutomationSchema, AutomationToolScopeSchema } from "@arden-hq/protocol/effect/automations"
import { RunOriginSchema } from "@arden-hq/protocol/effect/runs"
import { Effect, Result, Schema } from "effect"
import { freshRow } from "./automation-enqueue.js"
import { pendingDecisionCards } from "./pending-decision-cards.js"
import { causingAutomation } from "./run-cause.js"
import {
  AutomationId,
  type AutomationRules,
  type SystemAutomationSpec
} from "../automations/model.js"
import { changedSystemSettings, systemSettable } from "../automations/system-settings.js"
import { AutomationStoreError, type AutomationQueueSource } from "../automations/store.js"
import { JobPurposeSchema, type JobClassification } from "../job-classification.js"
import {
  AutomationSubjectSchema,
  SpaceId,
  SpaceReviewSubjectSchema,
  TaskItemId,
  TaskSubjectSchema,
  spaceJobId,
  taskJobId
} from "../space-job-id.js"
import { decodeJson, encodeJson } from "./json.js"
import { AutomationTriggersSchema } from "./automation-schedule.js"
import type { PersistenceDeps } from "./deps.js"
import type { SqlClient, Statement } from "effect/unstable/sql"
import { inArdenWords } from "../restart-notice.js"
import { oldConditions } from "../automations/event-words.js"

export type StoreOperation = AutomationStoreError["operation"]

export type AutomationRow = JobClassification & {
  readonly task_id: string
  readonly automation_ref: string
  readonly name: string
  readonly description: string | null
  readonly description_source: string | null
  readonly prompt: string
  readonly model: string | null
  readonly context_mode: AutomationContextMode
  readonly triggers: string
  readonly trigger_last_id: number
  readonly enabled: number
  readonly created_at: string
  readonly last_run_at: string | null
  readonly next_run_at: string | null
  readonly last_result: string | null
  readonly running_since: string | null
  readonly auto_approve: number
  readonly handler: string | null
  readonly builtin: number
  readonly cooldown_minutes: number | null
  readonly thread_id: string | null
  readonly thread_origin_automation_id: string | null
  readonly own_chat_id: string | null
  readonly tool_scope: string
  readonly triggers_source: string | null
  readonly prompt_author: string | null
  readonly instruction_revision_id: number | null
}

/** One queue row as it was asked for. A claim does not change these. */
export interface QueueEntry {
  readonly id: number
  readonly task_id: string
  readonly source: AutomationQueueSource
  readonly context: string
  readonly created_at: string
}

/**
 * The live claim on a queue row: who holds it now and until when. Every claim,
 * renewal, release and retry rewrites it, so nothing here names the attempt.
 */
export interface QueueClaim {
  readonly claimed_at: string | null
  /**
   * When a worker took hold of a Task's or a Space review's row. A renewal and
   * a reclaim keep it; a release, retry or deferral clears it. NULL for an
   * Automation's row, whose definition keeps its own hold start.
   */
  readonly hold_started_at: string | null
  readonly lease_expires_at: string | null
  readonly attempt_count: number
  readonly next_attempt_at: string | null
}

export const queueColumns = (sql: SqlClient.SqlClient): Statement.Fragment => sql`
  queue.id, queue.task_id, queue.source, queue.context, queue.created_at,
  queue.claimed_at, queue.hold_started_at, queue.lease_expires_at, queue.attempt_count,
  queue.next_attempt_at`

const ContextModeSchema = Schema.Literals(["fresh", "continue", "fork"])

/**
 * What an attempt was started as. The claim writes it once and a trigger on
 * `automation_runs` refuses any change, so it holds while the owner is edited
 * or deleted. The chat the attempt is pinned to and its claim count are not
 * here: they change while it runs.
 */
const BoundAttemptSchema = Schema.Struct({
  purpose: JobPurposeSchema,
  origin: Schema.fromJsonString(RunOriginSchema),
  itemId: Schema.NullOr(TaskItemId),
  generation: Schema.NullOr(Schema.Number),
  handler: Schema.NullOr(Schema.String),
  contextMode: ContextModeSchema
})
export type BoundAttempt = typeof BoundAttemptSchema.Type

/**
 * `attempt` names the `automation_runs` row in the query. The origin stays the
 * stored text, so text that is not JSON fails the decode and not the query.
 */
export const boundAttemptJson = (sql: SqlClient.SqlClient, attempt: string): Statement.Fragment => {
  const run = sql.literal(attempt)
  return sql`json_object('purpose', ${run}.purpose, 'origin', ${run}.origin,
    'itemId', ${run}.item_id,
    'generation', ${run}.task_generation, 'handler', ${run}.handler,
    'contextMode', ${run}.context_mode)`
}

/** What a person or the system wrote to set an Automation up. Only an Automation has it. */
const AuthoredConfigSchema = Schema.Struct({
  ref: Schema.String,
  name: Schema.String,
  prompt: Schema.String,
  model: Schema.NullOr(Schema.String),
  contextMode: ContextModeSchema,
  chatId: Schema.NullOr(Schema.String),
  /** The key the set chat was made for; null when the chat row is gone. */
  chatOrigin: Schema.NullOr(Schema.String),
  handler: Schema.NullOr(Schema.String),
  triggers: Schema.String,
  cooldownMinutes: Schema.NullOr(Schema.Number),
  instructionRevisionId: Schema.NullOr(Schema.Number)
})

/** What a definition's runs may do without asking. */
const DefinitionPolicySchema = Schema.Struct({
  toolScope: AutomationToolScopeSchema,
  autoApprove: Schema.Boolean
})

/** Where a definition's schedule and its worker hold stand now. */
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

/**
 * What a Space review's runs use that its Space does not say
 * (`space_review_settings`; the defaults when it has no row). A review has no
 * prompt of its own, no handler, no triggers and no instruction revision: its
 * prompt is built from the Space, and its chat is always its own.
 */
const ReviewSettingsSchema = Schema.Struct({
  model: Schema.NullOr(Schema.String),
  contextMode: ContextModeSchema,
  cooldownMinutes: Schema.NullOr(Schema.Number)
})

/** A Space review is owned by its Space: the row in `spaces` that its key names. */
const SpaceReviewOwnerSchema = Schema.Struct({
  ...SpaceReviewSubjectSchema.fields,
  key: AutomationId,
  /** Named after its Space, as its private chat is. */
  name: Schema.String,
  settings: ReviewSettingsSchema,
  /** Its private chat (`space_review_chats`); null until it is given one. */
  chatId: Schema.NullOr(Schema.String),
  /** Its Space has inference on, a page, and is not archived. */
  mayRun: Schema.Boolean
})

/**
 * A Task is its own owner: the row in `space_tasks`. It has no settings to
 * author, so there is no prompt, model, handler or tool scope here.
 */
const TaskOwnerSchema = Schema.Struct({
  ...TaskSubjectSchema.fields,
  key: AutomationId,
  spaceId: Schema.NullOr(SpaceId),
  text: Schema.String,
  /** The Task is open, the worker's, not held, and its Space is not archived. */
  stands: Schema.Boolean,
  /** Its private chat: the oldest live channel made for its key. */
  chatId: Schema.NullOr(Schema.String)
})

const WorkOwnerSchema = Schema.Union([
  AutomationOwnerSchema,
  SpaceReviewOwnerSchema,
  TaskOwnerSchema
])
export type WorkOwner = typeof WorkOwnerSchema.Type
export type DefinitionOwner = Extract<WorkOwner, { readonly kind: "automation" }>

/**
 * Which stored row a key names. Only an Automation has a definition. A Task is
 * the row in `space_tasks` and a Space review the row in `spaces` that the key
 * names. Old definition rows of Tasks and reviews are kept for the ids that
 * point at them, and name no owner. The key is `queue.task_id` unless given.
 */
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

/** The Space a review's key (`space:<space>`, `spaceJobId`) names; NULL for any other key. */
export const reviewSpaceIdSql = (
  sql: SqlClient.SqlClient,
  key: Statement.Fragment
): Statement.Fragment => sql`CASE WHEN substr(${key}, 1, 6) = 'space:' THEN substr(${key}, 7) END`

/** A review is named after its Space, as its private chat is (`syncSpaceReview`). */
export const reviewNameSql = (sql: SqlClient.SqlClient, space: string): Statement.Fragment =>
  sql`${sql.literal(space)}.name || ' worker'`

/**
 * When a job's runs act without asking. `own`: by the owner's own switch. `space`:
 * as its Space says, which is the owner's default approval mode.
 */
type OwnerApproval =
  | { readonly kind: "own"; readonly autoApprove: boolean }
  | { readonly kind: "space" }

/** What a job's runs may do, as its owner says now. */
export interface OwnerPolicy {
  readonly toolScope: AutomationToolScope
  readonly approval: OwnerApproval
}

/**
 * The one reading of a job's policy. An Automation has its own scope and switch on
 * its definition. A Space review and a Task have the Space tools and no setting of
 * their own: a review and a Task in a Space follow the Space; a Task outside any
 * Space asks first. Nothing here is stored for a review or a Task.
 */
export const ownerPolicy = (owner: WorkOwner): OwnerPolicy => {
  switch (owner.kind) {
    case "automation":
      return {
        toolScope: owner.policy.toolScope,
        approval: { kind: "own", autoApprove: owner.policy.autoApprove }
      }
    case "space_review":
      return { toolScope: "space", approval: { kind: "space" } }
    case "task":
      return {
        toolScope: "space",
        approval: owner.spaceId === null ? { kind: "own", autoApprove: false } : { kind: "space" }
      }
  }
}

/** A Space's review may run: inference on, a page bound, and not archived. */
export const reviewMayRunSql = (sql: SqlClient.SqlClient, space: string): Statement.Fragment => {
  const row = sql.literal(space)
  return sql`(json_extract(${row}.inference_policy, '$.enabled') = 1
    AND ${row}.page_path IS NOT NULL AND ${row}.archived_at IS NULL)`
}

const jsonBool = (sql: SqlClient.SqlClient, value: Statement.Fragment): Statement.Fragment =>
  sql`json(CASE WHEN ${value} THEN 'true' ELSE 'false' END)`

/**
 * The owner that `ownerJoin` found, as one tagged value; NULL when the key
 * names no stored row. Each kind carries only the facts it has.
 */
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

const decodeOwnerJson = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkOwnerSchema))

/** The owner in a row read with `ownerJson`, or undefined when the key names none. */
export const decodeOwner = (
  row: { readonly task_id: string; readonly owner: string | null },
  operation: StoreOperation
): Effect.Effect<WorkOwner | undefined, AutomationStoreError> =>
  row.owner === null
    ? Effect.succeed(undefined)
    : decodeOwnerJson(row.owner).pipe(
        Effect.mapError((cause) =>
          storeError(
            operation,
            "corrupt",
            "Stored Automation job owner is corrupt",
            row.task_id,
            cause
          )
        )
      )

const decodeBoundJson = Schema.decodeUnknownEffect(Schema.fromJsonString(BoundAttemptSchema))

/**
 * The attempt identity in a row read with `boundAttemptJson`. Its purpose, its
 * origin and its Task binding are one value: they must name the same work, and
 * that work must be the one stored under the row's key.
 */
export const decodeBoundAttempt = (
  row: { readonly task_id: string; readonly bound: string },
  operation: StoreOperation
): Effect.Effect<BoundAttempt, AutomationStoreError> =>
  decodeBoundJson(row.bound).pipe(
    Effect.mapError((cause) =>
      storeError(
        operation,
        "corrupt",
        "Stored Automation run identity is corrupt",
        row.task_id,
        cause
      )
    ),
    Effect.filterOrFail(
      (bound) => boundAgrees(bound, row.task_id),
      () =>
        storeError(operation, "corrupt", "Stored Automation run identity is corrupt", row.task_id)
    )
  )

const boundAgrees = (bound: BoundAttempt, key: string): boolean => {
  const { origin } = bound
  switch (bound.purpose) {
    case "task_execution":
      return (
        origin.kind === "task" &&
        origin.item_id === bound.itemId &&
        bound.generation !== null &&
        key === taskJobId(origin.item_id)
      )
    case "space_review":
      return (
        origin.kind === "space" &&
        bound.itemId === null &&
        bound.generation === null &&
        key === spaceJobId(origin.space_id)
      )
    case "user_automation":
    case "system":
      return (
        origin.kind === "automation" &&
        origin.automation_id === key &&
        bound.itemId === null &&
        bound.generation === null
      )
  }
}

/**
 * What an attempt that already exists was started as. A reclaim and a renewal
 * hand it out again from here, not from the owner as stored now, and refuse
 * an owner under its key that is other work.
 */
export const decodeOwnedAttempt = Effect.fn("AutomationRows.decodeOwnedAttempt")(function* (
  row: { readonly task_id: string; readonly bound: string },
  owner: WorkOwner,
  operation: "claim" | "renew"
) {
  const bound = yield* decodeBoundAttempt(row, operation)
  if (classificationOf(owner).purpose !== bound.purpose) {
    return yield* storeError(
      operation,
      "conflict",
      "Automation job owner is not what its attempt was started as",
      row.task_id
    )
  }
  return bound
})

/** The owner of one key, for a reader that has no queue row. */
export const readWorkOwner = Effect.fn("AutomationRows.readWorkOwner")(function* (
  sql: SqlClient.SqlClient,
  key: string
) {
  const rows = yield* sql<{ readonly owner: string | null }>`
    SELECT ${ownerJson(sql)} AS owner
    FROM (SELECT ${key} AS task_id) AS queue ${ownerJoin(sql)}`
  const owner = rows[0]?.owner ?? null
  return owner === null ? undefined : yield* decodeOwnerJson(owner)
})

export const isDefinition = (owner: WorkOwner | undefined): owner is DefinitionOwner =>
  owner?.kind === "automation"

/**
 * An Automation is on while enabled. A Task is on while it stands, and a
 * review while its Space lets it run.
 */
export const ownerIsOn = (owner: WorkOwner): boolean => {
  switch (owner.kind) {
    case "automation":
      return owner.state.enabled
    case "space_review":
      return owner.mayRun
    case "task":
      return owner.stands
  }
}

/** The classification the run origin and the event batch are written from. */
export const classificationOf = (owner: WorkOwner): JobClassification => {
  switch (owner.kind) {
    case "automation":
      return { purpose: owner.purpose, owner_space_id: null, owner_task_id: null }
    case "space_review":
      return { purpose: "space_review", owner_space_id: owner.spaceId, owner_task_id: null }
    case "task":
      return {
        purpose: "task_execution",
        owner_space_id: owner.spaceId,
        owner_task_id: owner.itemId
      }
  }
}

export const strict = { onExcessProperty: "error" } as const

export const storeError = (
  operation: StoreOperation,
  reason: AutomationStoreError["reason"],
  message: string,
  automationId?: string,
  cause?: unknown
) =>
  new AutomationStoreError({
    operation,
    reason,
    message,
    ...(automationId === undefined ? {} : { automationId }),
    ...(cause === undefined ? {} : { cause })
  })

export const automationIdEffect = (automationId: string, operation: StoreOperation) =>
  Schema.decodeUnknownEffect(Schema.Trim.check(Schema.isMinLength(1)))(automationId).pipe(
    Effect.mapError((cause) =>
      storeError(operation, "invalid", "Automation id must not be empty", undefined, cause)
    )
  )

export const skipCorrupt = <Row, A, R>(options: {
  readonly rows: ReadonlyArray<Row>
  readonly decode: (row: Row) => Effect.Effect<A, AutomationStoreError, R>
  readonly skipped: (row: Row) => Record<string, string | number>
  readonly what: string
}): Effect.Effect<Array<A>, AutomationStoreError, R> =>
  Effect.filterMapEffect(options.rows, (row) =>
    options.decode(row).pipe(
      Effect.map(Result.succeed),
      Effect.catchIf(
        (error) => error.reason === "corrupt",
        (error) =>
          Effect.logWarning(`Skipped ${options.what} that no longer decodes`).pipe(
            Effect.annotateLogs({ ...options.skipped(row), store_message: error.message }),
            Effect.as(Result.failVoid)
          )
      )
    )
  )

const automationChat = (row: AutomationRow): Automation["chat"] => {
  if (row.thread_id === null) return null
  return row.thread_origin_automation_id === row.task_id
    ? { kind: "own", session_id: row.thread_id }
    : { kind: "yours", session_id: row.thread_id, own_session_id: row.own_chat_id }
}

const automationHistory = (row: AutomationRow): Automation["history"] => {
  if (row.purpose === "system") return null
  return row.context_mode === "continue" ? "chat" : "fresh"
}

const scopeLabel = (scope: AutomationToolScope): string => {
  switch (scope) {
    case "read_only":
      return "Read only"
    case "reports":
      return "Read + save reports"
    case "browser":
      return "Browser on this Mac"
    case "all":
      return "All tools"
    case "space":
      return "Space tools"
    case "memory_capture":
      return "Memory capture"
    case "chat_summary":
      return "Chat summary"
  }
}

export const decodeQueueContext = (
  row: Pick<QueueEntry, "context" | "task_id">,
  operation: StoreOperation
) =>
  decodeJson(QueueContextSchema, row.context).pipe(
    Effect.mapError((cause) =>
      storeError(
        operation,
        "corrupt",
        "Stored Automation job context is corrupt",
        row.task_id,
        cause
      )
    )
  )

export const encodeQueueContext = (
  context: QueueContext,
  operation: StoreOperation,
  automationId: string
) =>
  encodeJson(QueueContextSchema, context).pipe(
    Effect.mapError((cause) =>
      storeError(
        operation,
        "storage",
        "Could not encode the Automation job context",
        automationId,
        cause
      )
    )
  )

export const systemSpecOf = (
  rules: Pick<AutomationRules["Service"], "systemSpec">,
  row: Pick<AutomationRow, "task_id" | "handler">,
  operation: StoreOperation
): Effect.Effect<SystemAutomationSpec, AutomationStoreError> => {
  const spec = row.handler === null ? undefined : rules.systemSpec(row.handler)
  return spec === undefined
    ? Effect.fail(
        storeError(
          operation,
          "corrupt",
          `System Automation has no registered handler: ${row.handler ?? "none"}`,
          row.task_id
        )
      )
    : Effect.succeed(spec)
}

/** An Automation's stored row, as both the list and the single read show it. */
export const automationRowSelect = (sql: SqlClient.SqlClient) => sql`
  SELECT task_id, automation_ref, name, description, description_source,
         prompt, model, context_mode, triggers, trigger_last_id, enabled, created_at, last_run_at,
         next_run_at, last_result, ${openRunSince(sql, sql`scheduled_tasks.task_id`)} AS running_since,
         auto_approve, handler, builtin, cooldown_minutes, thread_id, tool_scope, triggers_source,
         prompt_author, instruction_revision_id,
         purpose, owner_space_id, owner_task_id,
         (SELECT origin_automation_id FROM sessions WHERE session_id = scheduled_tasks.thread_id)
           AS thread_origin_automation_id,
         -- Its own chat: one lookup in idx_sessions_automation_channel, whose
         -- condition this repeats word for word.
         (SELECT session_id FROM sessions WHERE origin_automation_id = scheduled_tasks.task_id
           AND session_type = 'channel' AND archived_at IS NULL
           ORDER BY started_at DESC LIMIT 1) AS own_chat_id
  FROM scheduled_tasks`

export const makeAutomationRowReads = ({
  writer,
  rules
}: Pick<PersistenceDeps, "writer"> & {
  readonly rules: Pick<AutomationRules["Service"], "systemSpec">
}) => {
  const sql = writer.sql
  const project = Effect.fn("SqliteAutomationStore.project")(function* (
    row: AutomationRow,
    operation: StoreOperation
  ): Effect.fn.Return<Automation, AutomationStoreError> {
    const triggers = yield* decodeJson(AutomationTriggersSchema, row.triggers).pipe(
      Effect.mapError((cause) =>
        storeError(
          operation,
          "corrupt",
          "Stored Automation triggers are corrupt",
          row.task_id,
          cause
        )
      )
    )
    const statusRows = yield* sql<{ readonly id: number; readonly outcome: string | null }>`
      SELECT run.id, ${outcomeSql(sql, sql`run`)} AS outcome FROM automation_runs AS run
      WHERE run.task_id = ${row.task_id} AND ${countsAsRun(sql, sql`run`)}
      ORDER BY run.id DESC
      LIMIT 7
    `.pipe(
      Effect.mapError((cause) =>
        storeError(
          operation,
          "storage",
          "Could not load recent Automation outcomes",
          row.task_id,
          cause
        )
      )
    )
    const recentStatuses = yield* skipCorrupt({
      rows: statusRows,
      decode: (statusRow) =>
        shownRunStatus(statusRow.outcome).pipe(
          Effect.mapError((cause) =>
            storeError(
              operation,
              "corrupt",
              "Stored Automation outcome is corrupt",
              row.task_id,
              cause
            )
          )
        ),
      skipped: (statusRow) => ({ automation_id: row.task_id, run_id: statusRow.id }),
      what: "an Automation run"
    })
    const waitingRows = yield* sql<{ readonly waiting_on: "approval" | "connection" }>`
      SELECT CASE WHEN approval.action = 'connection' THEN 'connection' ELSE 'approval' END AS waiting_on
      FROM automation_runs AS run
      JOIN tool_approvals AS approval ON approval.run_id = run.chat_run_id
      WHERE run.task_id = ${row.task_id}
        AND run.status = 'running'
        AND approval.status = 'pending'
      ORDER BY run.id DESC, approval.requested_at
      LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        storeError(
          operation,
          "storage",
          "Could not load pending Automation attention",
          row.task_id,
          cause
        )
      )
    )
    const waitingEventRows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM automation_event_queue AS queue
      WHERE queue.task_id = ${row.task_id} AND queue.source = 'event' AND ${freshRow(sql)}
    `.pipe(
      Effect.mapError((cause) =>
        storeError(
          operation,
          "storage",
          "Could not count waiting Automation events",
          row.task_id,
          cause
        )
      )
    )
    const pendingRows = yield* sql<{
      readonly count: number
      readonly run_id: string
      readonly tool_call_id: string
      readonly session_id: string
      readonly destination_session_id: string
    }>`
      SELECT COUNT(*) OVER () AS count, card.run_id, card.tool_call_id, card.session_id,
        card.destination_session_id
      FROM (${pendingDecisionCards(sql)}) AS card
      JOIN chat_runs AS run ON run.run_id = card.run_id
      WHERE ${causingAutomation(sql, "run")} = ${row.task_id}
      ORDER BY card.requested_at, card.run_id, card.tool_call_id
      LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        storeError(
          operation,
          "storage",
          "Could not load pending Automation cards",
          row.task_id,
          cause
        )
      )
    )
    const scope = yield* Schema.decodeUnknownEffect(AutomationToolScopeSchema)(row.tool_scope).pipe(
      Effect.mapError((cause) =>
        storeError(
          operation,
          "corrupt",
          "Stored Automation tool scope is corrupt",
          row.task_id,
          cause
        )
      )
    )
    const spec = row.purpose === "system" ? yield* systemSpecOf(rules, row, operation) : null
    return yield* Schema.decodeUnknownEffect(AutomationSchema)({
      task_id: row.task_id,
      automation_ref: row.automation_ref,
      name: row.name,
      description: row.description,
      description_source: row.description_source,
      prompt: row.prompt,
      model: row.model,
      chat: automationChat(row),
      history: automationHistory(row),
      triggers,
      enabled: row.enabled === 1,
      created_at: row.created_at,
      last_run_at: row.last_run_at,
      next_run_at: row.next_run_at,
      recent_statuses: recentStatuses,
      latest_run_id: statusRows[0]?.id ?? null,
      last_result: inArdenWords(row.last_result),
      auto_approve: row.auto_approve === 1,
      running_since: row.running_since,
      waiting_on: waitingRows[0]?.waiting_on ?? null,
      waiting_events: waitingEventRows[0]?.count ?? 0,
      pending_approvals:
        pendingRows[0] === undefined
          ? null
          : {
              count: pendingRows[0].count,
              first: {
                run_id: pendingRows[0].run_id,
                tool_call_id: pendingRows[0].tool_call_id,
                session_id: pendingRows[0].session_id,
                destination_session_id: pendingRows[0].destination_session_id
              }
            },
      handler: row.handler,
      builtin: row.builtin === 1,
      cooldown_minutes: row.cooldown_minutes,
      old_conditions: oldConditions(triggers),
      tool_scope: scope,
      tool_scope_label: scopeLabel(scope),
      manual_run: spec?.manualRun ?? true,
      system:
        spec === null
          ? null
          : {
              default_triggers: spec.triggers,
              settable: systemSettable({
                contextMode: row.context_mode,
                runsModel: spec.runsModel
              }),
              changed: changedSystemSettings(row, spec)
            }
    }).pipe(
      Effect.mapError((cause) =>
        storeError(operation, "corrupt", "Stored Automation is corrupt", row.task_id, cause)
      )
    )
  })

  const findAutomationRow = Effect.fn("SqliteAutomationStore.findAutomationRow")(function* (
    automationId: string,
    operation: StoreOperation
  ) {
    const rows = yield* sql<AutomationRow>`
      ${automationRowSelect(sql)}
      WHERE task_id = ${automationId}
        AND purpose IN ('user_automation', 'system')
      LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        storeError(operation, "storage", "Could not load Automation", automationId, cause)
      )
    )
    return rows[0] ?? null
  })

  const get = Effect.fn("SqliteAutomationStore.get")(function* (automationId: string) {
    const validAutomationId = yield* automationIdEffect(automationId, "get")
    const row = yield* findAutomationRow(validAutomationId, "get")
    return row === null ? null : yield* project(row, "get")
  })

  return { project, findAutomationRow, get }
}

export type AutomationStoreDeps = Pick<
  PersistenceDeps,
  "writer" | "sessionEvents" | "reader" | "diagnostics"
> & {
  readonly rules: AutomationRules["Service"]
}
