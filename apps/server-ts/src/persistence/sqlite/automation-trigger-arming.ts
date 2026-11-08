import {
  type AutomationTrigger,
  type AutomationTriggerContext,
  type EventAutomationTrigger
} from "@arden-hq/protocol/automations"
import { Effect } from "effect"
import type { AutomationRules } from "../automations/model.js"
import { decodeJson, encodeJson } from "./json.js"
import { QueueContextSchema } from "./automation-queue-context.js"
import { AutomationStoreError } from "../automations/store.js"
import { listenerTriggers } from "./automation-schedule.js"
import type { PersistenceDeps } from "./deps.js"
import { type StoreOperation, storeError } from "./automation-rows.js"
import { iso } from "../../runtime/clock.js"
import { triggerChangeText } from "./automation-chat-quiet.js"
import { enqueue, freshRow } from "./automation-enqueue.js"
import { eventFromSnapshot, matchEvent } from "./automation-listening.js"
import type { SqlClient } from "effect/unstable/sql"

export const dropMeasuredRows = (sql: SqlClient.SqlClient, automationId: string) =>
  sql`DELETE FROM automation_event_queue
    WHERE task_id = ${automationId} AND ${freshRow(sql)}
      AND (source IN ('idle', 'count') OR (source = 'event' AND event_key LIKE 'chat.quiet:%'))`

export const rematchHeldEvents = Effect.fn("AutomationTriggerArming.rematchHeld")(
  function* (options: {
    readonly sql: SqlClient.SqlClient
    readonly rules: AutomationRules["Service"]
    readonly automationId: string
    readonly purpose: string
    readonly triggers: ReadonlyArray<AutomationTrigger>
  }) {
    const { sql, rules, automationId } = options
    const rows = yield* sql<{ readonly id: number; readonly context: string }>`
    SELECT id, context FROM automation_event_queue
    WHERE task_id = ${automationId} AND source = 'event' AND ${freshRow(sql)}`
    for (const row of rows) {
      const context = yield* decodeJson(QueueContextSchema, row.context).pipe(Effect.option)
      if (context._tag === "None") continue
      const event = eventFromSnapshot(context.value)
      if (event === undefined) continue
      const { matched, runOnlyIf } = matchEvent(rules, options.triggers, event, options.purpose)
      if (matched.length === 0) {
        yield* sql`DELETE FROM automation_event_queue WHERE id = ${row.id}`
        continue
      }
      const { run_only_if: _held, ...rest } = context.value
      yield* sql`UPDATE automation_event_queue
      SET context = ${yield* encodeJson(QueueContextSchema, runOnlyIf === undefined ? rest : { ...rest, run_only_if: runOnlyIf })}
      WHERE id = ${row.id}`
    }
  }
)

export const restartMeasuredTriggers = Effect.fn("AutomationTriggerArming.restartMeasured")(
  function* (sql: SqlClient.SqlClient, automationId: string) {
    yield* dropMeasuredRows(sql, automationId)
    yield* sql`DELETE FROM automation_idle_state WHERE task_id = ${automationId}`
    yield* sql`DELETE FROM automation_count_state WHERE task_id = ${automationId}`
  }
)

export interface ListeningAutomation {
  readonly automationId: string
  readonly idle: number | null
  readonly count: number | null
  readonly chatQuiet: EventAutomationTrigger | null
}

export const makeTriggerArming = ({
  writer,
  sessionEvents
}: Pick<PersistenceDeps, "writer" | "sessionEvents">) => {
  const sql = writer.sql
  const listeningAutomations = Effect.fn("SqliteAutomationStore.listeningAutomations")(function* (
    operation: StoreOperation
  ): Effect.fn.Return<ReadonlyArray<ListeningAutomation>, AutomationStoreError> {
    const rows = yield* sql<{
      readonly task_id: string
      readonly triggers: string
    }>`
      SELECT task_id, triggers
      FROM scheduled_tasks
      WHERE enabled = 1 AND purpose IN ('user_automation', 'system')
    `.pipe(
      Effect.mapError((cause) =>
        storeError(operation, "storage", "Could not list listening Automations", undefined, cause)
      )
    )
    const tasks: Array<ListeningAutomation> = []
    for (const row of rows) {
      const triggers = yield* listenerTriggers(row)
      if (triggers === undefined) continue
      const idle = triggers.find((trigger) => trigger.type === "idle")
      const count = triggers.find((trigger) => trigger.type === "count")
      const chatQuiet = triggers.find(
        (trigger): trigger is EventAutomationTrigger =>
          trigger.type === "event" && trigger.event_type === "chat.quiet"
      )
      if (idle === undefined && count === undefined && chatQuiet === undefined) continue
      tasks.push({
        automationId: row.task_id,
        idle: idle?.type === "idle" ? idle.idle_minutes : null,
        count: count?.type === "count" ? count.every_n : null,
        chatQuiet: chatQuiet ?? null
      })
    }
    return tasks
  })

  const armTrigger = Effect.fn("SqliteAutomationStore.armTrigger")(function* (
    automationId: string,
    dueMs: number,
    trigger: Extract<AutomationTriggerContext, { readonly source: "idle" | "count" }>
  ) {
    yield* enqueue(
      { sql, sessionEvents },
      {
        automationId,
        source: trigger.source,
        key: automationId,
        dueAt: dueMs,
        pending: "replace",
        context: {
          scheduled_for: null,
          automation_run_id: null,
          trigger_context: yield* triggerChangeText(sql, trigger),
          trigger_context_snapshot: trigger
        }
      }
    )
  })

  const rearmAutomation = Effect.fn("SqliteAutomationStore.rearmAutomation")(function* (
    task: ListeningAutomation,
    nowMs: number
  ) {
    if (task.idle !== null) {
      const rows = yield* sql<{
        readonly latest_input_sequence: number
        readonly latest_input_at: string
      }>`
        SELECT latest_input_sequence, latest_input_at FROM automation_idle_state
        WHERE task_id = ${task.automationId} AND latest_input_sequence > consumed_input_sequence`
      const latest = rows[0]
      if (latest !== undefined) {
        yield* armTrigger(
          task.automationId,
          Date.parse(latest.latest_input_at) + task.idle * 60_000,
          {
            source: "idle",
            queued_at: iso(nowMs),
            input_sequence: latest.latest_input_sequence,
            input_at: latest.latest_input_at
          }
        )
      }
    }
    if (task.count !== null) {
      const crossed = yield* sql<{
        readonly session_id: string
        readonly through_sequence: number | null
      }>`
        SELECT session_id, through_sequence FROM automation_count_state
        WHERE task_id = ${task.automationId} AND count >= ${task.count}
        LIMIT 1
      `
      const [first] = crossed
      if (first !== undefined) {
        yield* armTrigger(task.automationId, nowMs, {
          source: "count",
          queued_at: iso(nowMs),
          session_id: first.session_id,
          through_sequence: first.through_sequence,
          every_n: task.count
        })
        yield* sql`
          DELETE FROM automation_count_state
          WHERE task_id = ${task.automationId} AND count >= ${task.count}
        `
      }
    }
  })

  return { listeningAutomations, armTrigger, rearmAutomation }
}
