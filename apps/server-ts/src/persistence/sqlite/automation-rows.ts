import { countsAsRun } from "./automation-skip-record.js"
import { outcomeSql, shownRunStatus } from "./automation-run-outcome.js"
import { QueueContextSchema, type QueueContext } from "./automation-queue-context.js"
import type {
  Automation,
  AutomationContextMode,
  AutomationToolScope
} from "@arden-hq/protocol/automations"
import { AutomationSchema, AutomationToolScopeSchema } from "@arden-hq/protocol/effect/automations"
import { Effect, Result, Schema } from "effect"
import { freshRow } from "./automation-enqueue.js"
import { pendingDecisionCards } from "./pending-decision-cards.js"
import { causingAutomation } from "./run-cause.js"
import type { AutomationRules, SystemAutomationSpec } from "../automations/model.js"
import { changedSystemSettings, systemSettable } from "../automations/system-settings.js"
import { AutomationStoreError, type AutomationQueueSource } from "../automations/store.js"
import type { JobClassification } from "../job-classification.js"
import { decodeJson, encodeJson } from "./json.js"
import { AutomationTriggersSchema } from "./automation-schedule.js"
import type { PersistenceDeps } from "./deps.js"
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

export type QueueRow = JobClassification & {
  readonly id: number
  readonly task_id: string
  readonly name: string
  readonly source: AutomationQueueSource
  readonly context: string
  readonly created_at: string
  readonly claimed_at: string | null
  readonly lease_expires_at: string | null
  readonly attempt_count: number
  readonly next_attempt_at: string | null
  readonly prompt: string
  readonly model: string | null
  readonly context_mode: AutomationContextMode
  readonly run_chat_origin_automation_id: string | null
  readonly thread_id: string | null
  readonly handler: string | null
  readonly enabled: number
  readonly running_since: string | null
  readonly task_next_run_at: string | null
  readonly task_last_run_at: string | null
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
  row: Pick<QueueRow, "context" | "task_id">,
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
      SELECT task_id, automation_ref, name, description, description_source,
             prompt, model, context_mode, triggers, trigger_last_id, enabled, created_at, last_run_at,
             next_run_at, last_result, running_since, auto_approve, handler,
             builtin, cooldown_minutes, thread_id, tool_scope, triggers_source,
             prompt_author, instruction_revision_id,
             purpose, owner_space_id, owner_task_id,
             (SELECT origin_automation_id FROM sessions WHERE session_id = scheduled_tasks.thread_id)
               AS thread_origin_automation_id,
             (SELECT session_id FROM sessions WHERE origin_automation_id = scheduled_tasks.task_id
               AND session_type = 'channel' AND archived_at IS NULL
               ORDER BY started_at DESC LIMIT 1) AS own_chat_id
      FROM scheduled_tasks
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
