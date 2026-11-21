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
