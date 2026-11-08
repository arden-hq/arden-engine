import type { RunContext, RunOrigin, RunTaskBinding } from "@arden-hq/protocol/runs"
import {
  RunContextSchema,
  RunOriginSchema,
  RunTaskBindingSchema
} from "@arden-hq/protocol/effect/runs"
import { Effect, Schema } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import type { JobClassification } from "../job-classification.js"
import { WorkStoreError } from "../work/store.js"
import { decodeJson } from "./json.js"
import { runPolicyRevoked } from "./run-policy.js"
import { executionBudgetExpired } from "./execution-budgets.js"
import { taskHasHold } from "./task-hold-state.js"
import { taskOpenSql } from "./task-status-sql.js"
import { userChatSql } from "./chat-ownership.js"

const taskBindingRevoked = (sql: SqlClient.SqlClient, metadata: Statement.Fragment) => sql`(
  json_extract(${metadata}, '$.run_context.task.item_id') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM space_tasks AS authority_task
    LEFT JOIN spaces AS authority_space ON authority_space.space_id = authority_task.space_id
    WHERE authority_task.item_id = json_extract(${metadata}, '$.run_context.task.item_id')
      AND authority_task.generation = json_extract(${metadata}, '$.run_context.task.generation')
      AND ${taskOpenSql("authority_task")} AND authority_task.owner = 'worker'
      AND NOT ${taskHasHold(sql, sql`authority_task`)}
      AND (authority_task.space_id IS NULL
        OR authority_space.archived_at IS NULL))
)`

export type RunAuthorityState = "active" | "settling" | "revoked"

const taskBindingSettling = (
  sql: SqlClient.SqlClient,
  metadata: Statement.Fragment,
  runId: Statement.Fragment
) => sql`(
  ${taskBindingRevoked(sql, metadata)} AND EXISTS (
    SELECT 1 FROM space_task_events AS own_change
    JOIN space_tasks AS task ON task.item_id = own_change.item_id
    WHERE own_change.item_id = json_extract(${metadata}, '$.run_context.task.item_id')
      AND own_change.run_ref = ${runId}
      AND own_change.created_at = task.updated_at
      AND own_change.event_type IN ('done', 'cancelled')
  )
)`

export const runAuthorityState = (
  sql: SqlClient.SqlClient,
  metadata: Statement.Fragment,
  runId: Statement.Fragment
) => sql`(CASE
  WHEN ${executionBudgetExpired(sql, metadata)} OR ${runPolicyRevoked(sql, metadata)} THEN 'revoked'
  WHEN NOT ${taskBindingRevoked(sql, metadata)} THEN 'active'
  WHEN ${taskBindingSettling(sql, metadata, runId)} THEN 'settling'
  ELSE 'revoked'
END)`

export const assertRunTaskBinding = Effect.fn(function* (
  sql: SqlClient.SqlClient,
  runId: string,
  itemId?: string
) {
  const rows = yield* sql<{
    readonly authority: RunAuthorityState
    readonly item_id: string | null
  }>`
    SELECT ${runAuthorityState(sql, sql`metadata_json`, sql`run_id`)} AS authority,
      json_extract(metadata_json, '$.run_context.task.item_id') AS item_id
    FROM chat_runs WHERE run_id = ${runId}
  `.pipe(
    Effect.mapError(
      (cause) =>
        new WorkStoreError({
          reason: "storage",
          message: "Could not inspect Task authority",
          cause
        })
    )
  )
  const row = rows[0]
  if (
    !row ||
    row.authority !== "active" ||
    (row.item_id !== null && itemId !== undefined && row.item_id !== itemId)
  ) {
    return yield* new WorkStoreError({
      reason: "conflict",
      message: "This Task attempt no longer has authority for that action"
    })
  }
  return { taskItemId: row.item_id ?? undefined }
})

export const assertRunModelAuthority = Effect.fn(function* (
  sql: SqlClient.SqlClient,
  runId: string
) {
  const rows = yield* sql<{ readonly authority: RunAuthorityState }>`
    SELECT ${runAuthorityState(sql, sql`metadata_json`, sql`run_id`)} AS authority
    FROM chat_runs WHERE run_id = ${runId}
  `.pipe(
    Effect.mapError(
      (cause) =>
        new WorkStoreError({
          reason: "storage",
          message: "Could not inspect Run authority",
          cause
        })
    )
  )
  if (rows[0] === undefined || rows[0].authority === "revoked") {
    return yield* new WorkStoreError({
      reason: "conflict",
      message: "This Run no longer has authority for model requests"
    })
  }
})

export const queueOccurrenceId = (row: { readonly id: number; readonly created_at: string }) =>
  `queue:${row.id}@${row.created_at}`

export const scheduledRunOrigin = (options: {
  readonly job: JobClassification
  readonly automationId: string
  readonly occurrenceId: string
  readonly chainDepth: number
}): RunOrigin => {
  switch (options.job.purpose) {
    case "task_execution":
      return {
        kind: "task",
        item_id: options.job.owner_task_id,
        occurrence_id: options.occurrenceId
      }
    case "space_review":
      return {
        kind: "space",
        space_id: options.job.owner_space_id,
        occurrence_id: options.occurrenceId
      }
    case "user_automation":
    case "system":
      return {
        kind: "automation",
        automation_id: options.automationId,
        occurrence_id: options.occurrenceId,
        ...(options.chainDepth === 0 ? {} : { chain_depth: options.chainDepth })
      }
  }
}

export const captureRunTask = Effect.fn("RunContext.captureTask")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly itemId: string | undefined
  readonly spaceId?: string | null
}): Effect.fn.Return<RunTaskBinding | null, WorkStoreError> {
  if (options.itemId === undefined) return null
  const rows = yield* options.sql<{ readonly item_id: string; readonly generation: number }>`
    SELECT task.item_id, task.generation FROM space_tasks AS task
    LEFT JOIN spaces AS space ON space.space_id = task.space_id
    WHERE task.item_id = ${options.itemId}
      AND ${taskOpenSql("task")} AND task.owner = 'worker'
      AND NOT ${taskHasHold(options.sql, options.sql`task`)}
      AND (task.space_id IS NULL OR space.archived_at IS NULL)
      AND (${options.spaceId === undefined ? 1 : 0} = 1 OR task.space_id IS ${options.spaceId ?? null})
  `.pipe(
    Effect.mapError(
      (cause) =>
        new WorkStoreError({
          reason: "storage",
          message: "Could not bind the Run to its Task",
          cause
        })
    )
  )
  return yield* Schema.decodeUnknownEffect(RunTaskBindingSchema)(rows[0]).pipe(
    Effect.mapError(
      (cause) =>
        new WorkStoreError({
          reason: "invalid",
          message: "The Run requires an open worker-owned Task in its current Space",
          cause
        })
    )
  )
})

export const continuedContext = Effect.fn("RunContext.continued")(function* (
  sql: SqlClient.SqlClient,
  previousJson: string
) {
  const previous = yield* decodeJson(RunContextSchema, previousJson).pipe(
    Effect.mapError(
      (cause) => new WorkStoreError({ reason: "invalid", message: "Run context is corrupt", cause })
    )
  )
  return {
    origin: previous.origin,
    task: yield* captureRunTask({ sql, itemId: previous.task?.item_id }),
    ...(previous.belongs_to === undefined ? {} : { belongs_to: previous.belongs_to })
  } satisfies RunContext
})

interface RunCause {
  readonly type: "message" | "run" | "tool_call" | "workflow"
  readonly id: string
}

const causedRunBelongsTo = Effect.fn("RunContext.belongsTo")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly sessionId: string
    readonly cause: RunCause | undefined
    readonly senderRef: string | undefined
  }
): Effect.fn.Return<RunOrigin | undefined, WorkStoreError> {
  const causingRun = causingRunSql(sql, input)
  if (causingRun === undefined) return undefined
  const rows = yield* sql<{ readonly belongs_to: string | null }>`
    SELECT owned.belongs_to FROM (
      SELECT COALESCE(json_extract(cause.metadata_json, '$.run_context.belongs_to'),
          json_extract(cause.metadata_json, '$.run_context.origin')) AS belongs_to
      FROM chat_runs AS cause
      WHERE cause.run_id = ${causingRun}
        AND NOT EXISTS (SELECT 1 FROM sessions AS chat
          WHERE chat.session_id = ${input.sessionId} AND ${userChatSql("chat")})
    ) AS owned
    WHERE json_extract(owned.belongs_to, '$.kind') IS NOT 'chat'
      OR EXISTS (SELECT 1 FROM sessions AS chat
        WHERE chat.session_id = json_extract(owned.belongs_to, '$.session_id')
          AND ${userChatSql("chat")})`.pipe(
    Effect.mapError(
      (cause) =>
        new WorkStoreError({ reason: "storage", message: "Could not read the causing run", cause })
    )
  )
  const stored = rows[0]?.belongs_to
  if (stored === undefined || stored === null) return undefined
  return yield* decodeJson(RunOriginSchema, stored).pipe(
    Effect.mapError(
      (cause) =>
        new WorkStoreError({ reason: "invalid", message: "Causing run origin is corrupt", cause })
    )
  )
})

export const withCausedBelongsTo = Effect.fn("RunContext.withCausedBelongsTo")(function* (
  sql: SqlClient.SqlClient,
  context: RunContext,
  input: {
    readonly sessionId: string
    readonly causingRunId: string | undefined
    readonly interaction:
      | { readonly causedBy?: RunCause; readonly from: { readonly id: string } }
      | undefined
  }
): Effect.fn.Return<RunContext, WorkStoreError> {
  if (context.origin.kind !== "chat" || context.belongs_to !== undefined) return context
  const belongsTo = yield* causedRunBelongsTo(sql, {
    sessionId: input.sessionId,
    cause:
      input.interaction?.causedBy ??
      (input.causingRunId === undefined ? undefined : { type: "run", id: input.causingRunId }),
    senderRef: input.interaction?.from.id
  })
  return belongsTo === undefined ? context : { ...context, belongs_to: belongsTo }
})

const causingRunSql = (
  sql: SqlClient.SqlClient,
  input: {
    readonly sessionId: string
    readonly cause: RunCause | undefined
    readonly senderRef: string | undefined
  }
): Statement.Fragment | undefined => {
  const { cause } = input
  switch (cause?.type) {
    case undefined:
    case "message":
      return undefined
    case "run":
      return sql`${cause.id}`
    case "tool_call":
      return sql`(SELECT call.run_id FROM tool_calls AS call
        WHERE call.tool_call_id = ${cause.id} AND call.session_id IN (${input.sessionId},
          (SELECT session_id FROM sessions WHERE public_ref = ${input.senderRef ?? null}))
        ORDER BY call.started_at DESC LIMIT 1)`
    case "workflow": {
      const scriptRef = cause.id.slice(0, cause.id.lastIndexOf(":"))
      return sql`(SELECT origin_run_id FROM code_mode_scripts WHERE script_ref = ${scriptRef})`
    }
  }
}

export const captureChildTask = Effect.fn("RunContext.captureChildTask")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly parentRunId: string
  readonly requestedItemId: string | undefined
  readonly spaceId: string | null
}) {
  const rows = yield* options.sql<{ readonly item_id: string | null }>`
    SELECT json_extract(metadata_json, '$.run_context.task.item_id') AS item_id
    FROM chat_runs WHERE run_id = ${options.parentRunId}
  `.pipe(
    Effect.mapError(
      (cause) =>
        new WorkStoreError({
          reason: "storage",
          message: "Could not read parent Task authority",
          cause
        })
    )
  )
  const inherited = rows[0]
  if (
    inherited?.item_id &&
    options.requestedItemId &&
    inherited.item_id !== options.requestedItemId
  ) {
    return yield* new WorkStoreError({
      reason: "invalid",
      message: "A Task worker cannot delegate authority for another Task"
    })
  }
  return yield* captureRunTask({
    sql: options.sql,
    ...(inherited?.item_id ? {} : { spaceId: options.spaceId }),
    itemId: inherited?.item_id ?? options.requestedItemId
  })
})

export const captureScheduledContext = Effect.fn("RunContext.captureScheduled")(
  function* (options: {
    readonly sql: SqlClient.SqlClient
    readonly automationId: string
    readonly attemptId: number
  }): Effect.fn.Return<RunContext, WorkStoreError> {
    const rows = yield* options.sql<{
      readonly origin: string
      readonly item_id: string | null
      readonly task_generation: number | null
    }>`
    SELECT origin, item_id, task_generation FROM automation_runs
    WHERE id = ${options.attemptId} AND task_id = ${options.automationId} AND status = 'running'
  `.pipe(
      Effect.mapError(
        (cause) =>
          new WorkStoreError({
            reason: "storage",
            message: "Could not read admitted attempt",
            cause
          })
      )
    )
    const row = rows[0]
    if (!row)
      return yield* new WorkStoreError({
        reason: "invalid",
        message: "Scheduled attempt is no longer active"
      })
    const origin = yield* decodeJson(RunOriginSchema, row.origin).pipe(
      Effect.mapError(
        (cause) =>
          new WorkStoreError({ reason: "storage", message: "Attempt origin is corrupt", cause })
      )
    )
    const task = yield* captureRunTask({ sql: options.sql, itemId: row.item_id ?? undefined })
    if (task !== null && task.generation !== row.task_generation) {
      return yield* new WorkStoreError({
        reason: "conflict",
        message: "The admitted Task attempt no longer has authority"
      })
    }
    return { origin, task }
  }
)

export const recordChildAttempt = Effect.fn("RunContext.recordChildAttempt")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly runId: string
  readonly sessionId: string
  readonly context: RunContext
  readonly now: string
}) {
  yield* options.sql`
    INSERT INTO automation_runs (
      task_id, automation_ref, origin, item_id, task_generation,
      chat_run_id, chat_session_id, started_at, status, purpose, context_mode
    ) VALUES (
      NULL, NULL, ${JSON.stringify(options.context.origin)},
      ${options.context.task?.item_id ?? null}, ${options.context.task?.generation ?? null},
      ${options.runId}, ${options.sessionId}, ${options.now}, 'running',
      ${options.context.task === null ? null : "task_execution"}, 'continue'
    )
  `.pipe(
    Effect.mapError(
      (cause) =>
        new WorkStoreError({
          reason: "storage",
          message: "Could not record the Worker attempt",
          cause
        })
    )
  )
})

export const wokenOccurrence = Effect.fn("RunContext.wokenOccurrence")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly sessionId: string
  readonly sourceRunId: string
  readonly now: string
}) {
  const rows = yield* options.sql<{
    readonly attempt_id: number
    readonly automation_id: string
    readonly leased: number
  }>`
    SELECT attempt.id AS attempt_id, attempt.task_id AS automation_id,
      EXISTS (SELECT 1 FROM automation_event_queue AS queue
        WHERE queue.task_id = attempt.task_id
          AND json_extract(queue.context, '$.automation_run_id') = attempt.id
          AND queue.claimed_at IS NOT NULL AND queue.lease_expires_at > ${options.now}) AS leased
    FROM chat_runs AS source
    JOIN chat_runs AS root ON root.run_id = json_extract(source.authority_json, '$.delegation.chain[0]')
    JOIN automation_runs AS attempt ON attempt.status = 'running' AND attempt.task_id IS NOT NULL
      AND attempt.chat_session_id = root.session_id
      AND json(attempt.origin) = json_extract(root.metadata_json, '$.run_context.origin')
    WHERE source.run_id = ${options.sourceRunId} AND root.session_id = ${options.sessionId}
    LIMIT 1
  `.pipe(
    Effect.mapError(
      (cause) =>
        new WorkStoreError({
          reason: "storage",
          message: "Could not read the occurrence that started this agent",
          cause
        })
    )
  )
  const row = rows[0]
  if (row === undefined) return undefined
  if (row.leased !== 1)
    return yield* new WorkStoreError({
      reason: "conflict",
      message: "The agent's result waits for its Automation to resume"
    })
  return { automationId: row.automation_id, attemptId: row.attempt_id }
})
