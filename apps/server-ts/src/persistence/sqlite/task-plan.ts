import type { TodoListItem } from "@arden-hq/protocol"
import { TodoListItemSchema } from "@arden-hq/protocol/effect/common"
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { finishDecision, originalRequest, taskWords } from "../todos/items.js"
import { decodeJson, type JsonColumnError } from "./json.js"
import { workError } from "./work-records.js"
import { WorkStoreError, type TaskFinishCheck } from "../work/store.js"
import type { SqlError } from "effect/unstable/sql/SqlError"

const TodoItemsSchema = Schema.Array(TodoListItemSchema)

export const readRunPlan = Effect.fn("Work.readRunPlan")(function* (
  sql: SqlClient.SqlClient,
  runId: string
) {
  const rows = yield* sql<{ readonly items_json: string }>`
    SELECT todo.items_json FROM session_todos AS todo
    JOIN chat_runs AS run ON run.session_id = todo.session_id
    WHERE run.run_id = ${runId}
    ORDER BY todo.edited DESC LIMIT 1`
  if (rows[0] === undefined) return undefined
  return yield* decodeJson(TodoItemsSchema, rows[0].items_json).pipe(
    Effect.map((items): ReadonlyArray<TodoListItem> | undefined => items),
    Effect.orElseSucceed(() => undefined)
  )
})

const readRequestRow = Effect.fn("Work.readRequestRow")(function* (
  sql: SqlClient.SqlClient,
  itemId: string
) {
  const rows = yield* sql<{
    readonly text: string
    readonly body: string | null
    readonly original_body: string | null
    readonly origin_message_id: string | null
    readonly origin_text: string | null
  }>`
    SELECT task.text, task.body, task.original_body, task.origin_message_id,
      (SELECT message.search_text FROM space_task_sources AS source
        JOIN session_messages AS message
          ON message.session_id = json_extract(source.source, '$.session_id')
        WHERE source.item_id = task.item_id AND json_extract(source.source, '$.kind') = 'chat'
          AND message.message_id = task.origin_message_id
        LIMIT 1) AS origin_text
    FROM space_tasks AS task WHERE task.item_id = ${itemId}`
  return rows[0]
})

const readOriginalRequest = Effect.fn("Work.readOriginalRequest")(function* (
  sql: SqlClient.SqlClient,
  itemId: string
) {
  const row = yield* readRequestRow(sql, itemId)
  return row === undefined ? undefined : originalRequest(row)
})

export const readTaskIntent = Effect.fn("Work.readTaskIntent")(function* (
  sql: SqlClient.SqlClient,
  itemId: string
) {
  const row = yield* readRequestRow(sql, itemId)
  return row === undefined ? undefined : { asked: originalRequest(row).text, now: taskWords(row) }
})

export const makeFinishCheck = (sql: SqlClient.SqlClient) =>
  Effect.fn("Work.finishCheck")(
    function* ({
      runId,
      itemId
    }: {
      readonly runId: string
      readonly itemId: string
    }): Effect.fn.Return<TaskFinishCheck, WorkStoreError | SqlError | JsonColumnError> {
      const items = yield* readRunPlan(sql, runId)
      const warned = yield* sql`SELECT 1 FROM tool_calls
        WHERE run_id = ${runId} AND tool_name = 'task_finish' AND status = 'completed'
          AND json_extract(result_json, '$.data.finish_check.item_id') = ${itemId}
          AND json_extract(result_json, '$.data.finish_check.closed') = 0
        LIMIT 1`
      const decision = finishDecision({ itemId, items, warned: warned.length > 0 })
      if (decision.kind === "close") return decision
      return { ...decision, request: yield* readOriginalRequest(sql, itemId) }
    },
    Effect.mapError((cause) =>
      cause instanceof WorkStoreError
        ? cause
        : workError("storage", "Could not check the Task's todo list", cause)
    )
  )
