import { AUTOMATION_APPROVAL } from "@arden-hq/protocol/permissions"
import { RUN_ORIGIN } from "@arden-hq/protocol/runs"
import { RunOriginSchema } from "../runs/stored-context.js"
import type { AutomationContextMode, AutomationToolScope } from "@arden-hq/protocol/automations"
import { Effect, Result, Schema, type SchemaAST } from "effect"
import { type AutomationRules, type SystemAutomationSpec } from "../automations/model.js"
import { AutomationStoreError, type AutomationQueueSource } from "../automations/store.js"
import { JOB_PURPOSE, JobPurposeSchema, type JobClassification } from "../job-classification.js"
import { JOB_SUBJECT_KIND, TaskItemId, spaceJobId, taskJobId } from "../space-job-id.js"
import type { PersistenceDeps } from "./deps.js"
import type { SqlClient, Statement } from "effect/unstable/sql"
import {
  ownerJson,
  type DefinitionOwner,
  type WorkOwner,
  ContextModeSchema,
  WorkOwnerSchema,
  ownerJoin
} from "./automation-owner.js"
export {
  hasOwner,
  ownerJoin,
  ownerJson,
  reviewMayRunSql,
  reviewNameSql,
  reviewSpaceIdSql
} from "./automation-owner.js"
export type { DefinitionOwner, WorkOwner } from "./automation-owner.js"

export type StoreOperation = AutomationStoreError["operation"]

export type AutomationRow = JobClassification & {
  readonly task_id: string
  readonly automation_ref: string
  readonly name: string
  readonly description: string | null
  readonly description_source: DescriptionSource | null
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

export interface QueueEntry {
  readonly id: number
  readonly task_id: string
  readonly source: AutomationQueueSource
  readonly context: string
  readonly created_at: string
}

export interface QueueClaim {
  readonly claimed_at: string | null
  readonly hold_started_at: string | null
  readonly lease_expires_at: string | null
  readonly attempt_count: number
  readonly next_attempt_at: string | null
}

export const queueColumns = (sql: SqlClient.SqlClient): Statement.Fragment => sql`
  queue.id, queue.task_id, queue.source, queue.context, queue.created_at,
  queue.claimed_at, queue.hold_started_at, queue.lease_expires_at, queue.attempt_count,
  queue.next_attempt_at`

const BoundAttemptSchema = Schema.Struct({
  purpose: JobPurposeSchema,
  origin: Schema.fromJsonString(RunOriginSchema),
  itemId: Schema.NullOr(TaskItemId),
  generation: Schema.NullOr(Schema.Number),
  handler: Schema.NullOr(Schema.String),
  contextMode: ContextModeSchema
})
export type BoundAttempt = typeof BoundAttemptSchema.Type

export const boundAttemptJson = (sql: SqlClient.SqlClient, attempt: string): Statement.Fragment => {
  const run = sql.literal(attempt)
  return sql`json_object('purpose', ${run}.purpose, 'origin', ${run}.origin,
    'itemId', ${run}.item_id,
    'generation', ${run}.task_generation, 'handler', ${run}.handler,
    'contextMode', ${run}.context_mode)`
}

type OwnerApproval =
  | { readonly kind: typeof AUTOMATION_APPROVAL.own; readonly autoApprove: boolean }
  | { readonly kind: typeof AUTOMATION_APPROVAL.space }

export interface OwnerPolicy {
  readonly toolScope: AutomationToolScope
  readonly approval: OwnerApproval
}

export const ownerPolicy = (owner: WorkOwner): OwnerPolicy => {
  switch (owner.kind) {
    case JOB_SUBJECT_KIND.automation:
      return {
        toolScope: owner.policy.toolScope,
        approval: { kind: "own", autoApprove: owner.policy.autoApprove }
      }
    case JOB_SUBJECT_KIND.spaceReview:
      return { toolScope: "space", approval: { kind: "space" } }
    case JOB_SUBJECT_KIND.task:
      return {
        toolScope: "space",
        approval: owner.spaceId === null ? { kind: "own", autoApprove: false } : { kind: "space" }
      }
  }
}

const decodeOwnerJson = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkOwnerSchema))

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
    case JOB_PURPOSE.taskExecution:
      return (
        origin.kind === RUN_ORIGIN.task &&
        origin.item_id === bound.itemId &&
        bound.generation !== null &&
        key === taskJobId(origin.item_id)
      )
    case JOB_PURPOSE.spaceReview:
      return (
        origin.kind === RUN_ORIGIN.space &&
        bound.itemId === null &&
        bound.generation === null &&
        key === spaceJobId(origin.space_id)
      )
    case JOB_PURPOSE.userAutomation:
    case JOB_PURPOSE.system:
      return (
        origin.kind === RUN_ORIGIN.automation &&
        origin.automation_id === key &&
        bound.itemId === null &&
        bound.generation === null
      )
  }
}

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
  owner?.kind === JOB_SUBJECT_KIND.automation

export const ownerIsOn = (owner: WorkOwner): boolean => {
  switch (owner.kind) {
    case JOB_SUBJECT_KIND.automation:
      return owner.state.enabled
    case JOB_SUBJECT_KIND.spaceReview:
      return owner.mayRun
    case JOB_SUBJECT_KIND.task:
      return owner.stands
  }
}

export const classificationOf = (owner: WorkOwner): JobClassification => {
  switch (owner.kind) {
    case JOB_SUBJECT_KIND.automation:
      return { purpose: owner.purpose, owner_space_id: null, owner_task_id: null }
    case JOB_SUBJECT_KIND.spaceReview:
      return { purpose: "space_review", owner_space_id: owner.spaceId, owner_task_id: null }
    case JOB_SUBJECT_KIND.task:
      return {
        purpose: "task_execution",
        owner_space_id: owner.spaceId,
        owner_task_id: owner.itemId
      }
  }
}

export const DESCRIPTION_SOURCE = { manual: "manual", generated: "generated" } as const

type DescriptionSource = (typeof DESCRIPTION_SOURCE)[keyof typeof DESCRIPTION_SOURCE]

export const strict: SchemaAST.ParseOptions = { onExcessProperty: "error" }

export const storeError = (
  operation: StoreOperation,
  reason: AutomationStoreError["reason"],
  message: string,
  automationId?: string,
  cause?: unknown
): AutomationStoreError =>
  new AutomationStoreError({
    operation,
    reason,
    message,
    ...(automationId === undefined ? {} : { automationId }),
    ...(cause === undefined ? {} : { cause })
  })

export const automationIdEffect = (
  automationId: string,
  operation: StoreOperation
): Effect.Effect<string, AutomationStoreError> =>
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

export type AutomationStoreDeps = Pick<
  PersistenceDeps,
  "writer" | "sessionEvents" | "reader" | "diagnostics"
> & {
  readonly rules: AutomationRules["Service"]
}
