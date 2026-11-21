import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { WorkStoreError } from "../work/store.js"
import {
  TaskDirectionChanged,
  TaskDirectionReceiptSchema,
  sameDirection,
  taskDirectionReceipt,
  type TaskDirection
} from "../work/task-direction.js"
import { decodeJson } from "./json.js"
import { readTaskContract } from "./task-contract.js"

/**
 * A Task's direction as stored now: the same row and contract reader the run's context
 * shows it from (space-job-context.ts). Undefined when the Task is gone.
 */
export const readTaskDirection = Effect.fn("TaskDirection.read")(function* (
  sql: SqlClient.SqlClient,
  itemId: string
) {
  const rows = yield* sql<{ readonly text: string; readonly body: string | null }>`
    SELECT text, body FROM space_tasks WHERE item_id = ${itemId}`
  const row = rows[0]
  if (row === undefined) return undefined
  const contract = yield* readTaskContract(sql, itemId)
  return {
    itemId,
    text: row.text,
    body: row.body ?? undefined,
    lines: contract.lines
  } satisfies TaskDirection
})

/**
 * Whether a started call's stored plan matches its run's Task now, read in the caller's
 * transaction. "current" also for a run with no Task. "needs_review" when the direction
 * changed, or when a Task run's call has no stored plan: such a call (from before plans
 * were stored, or from a turn shown none) is never run on today's Task. "no_call" when no
 * durable call has that id: the caller is not a durable tool call.
 */
export const readCallPlan = Effect.fn("TaskDirection.readCallPlan")(function* (
  sql: SqlClient.SqlClient,
  call: { readonly runId: string; readonly toolCallId: string }
) {
  const rows = yield* sql<{
    readonly planned_from_json: string | null
    readonly item_id: string | null
  }>`
    SELECT planned.planned_from_json,
      json_extract(run.metadata_json, '$.run_context.task.item_id') AS item_id
    FROM tool_calls AS planned JOIN chat_runs AS run ON run.run_id = planned.run_id
    WHERE planned.run_id = ${call.runId} AND planned.tool_call_id = ${call.toolCallId}`
  const row = rows[0]
  if (row === undefined) return "no_call" as const
  if (row.item_id === null) return "current" as const
  if (row.planned_from_json === null) return "needs_review" as const
  const planned = yield* decodeJson(TaskDirectionReceiptSchema, row.planned_from_json)
  const direction = yield* readTaskDirection(sql, row.item_id)
  return direction !== undefined && sameDirection(planned, taskDirectionReceipt(direction))
    ? ("current" as const)
    : ("needs_review" as const)
})

/**
 * A Task write a durable call asked for, checked in the write's own transaction: the
 * direction cannot change between this check and the write. Fails with
 * `TaskDirectionChanged` when the call's plan is stale.
 */
export const assertCallPlan = Effect.fn("TaskDirection.assertCallPlan")(function* (
  sql: SqlClient.SqlClient,
  call: { readonly runId: string; readonly toolCallId: string }
) {
  const plan = yield* readCallPlan(sql, call).pipe(
    Effect.mapError(
      (cause) =>
        new WorkStoreError({ reason: "storage", message: "Could not check the call's plan", cause })
    )
  )
  if (plan === "needs_review")
    return yield* new TaskDirectionChanged({
      message: "The Task changed after this call was planned"
    })
})
