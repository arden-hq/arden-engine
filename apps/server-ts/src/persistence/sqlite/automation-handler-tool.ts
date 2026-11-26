import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { AutomationQueue, HandlerToolName } from "../automations/queue.js"
import type { AutomationStoreDeps } from "./automation-rows.js"
import { storeError } from "./automation-rows.js"
import {
  STORED_TOOL_RESULT_ERROR_TAG,
  STORED_TOOL_RESULT_REASON,
  loadFullResult
} from "./tool-result-storage.js"

export const handlerToolContent = Effect.fn("AutomationHandlerTool.content")(function* (
  sql: SqlClient.SqlClient,
  input: { readonly runId: string; readonly tool: HandlerToolName }
) {
  const rows = yield* sql<{ readonly result_json: string }>`
    SELECT result_json FROM tool_calls
    WHERE run_id = ${input.runId} AND tool_name = ${input.tool} AND status = 'completed'
      AND COALESCE(json_extract(result_json, '$.is_error'), 0) = 0
    ORDER BY ended_at DESC, tool_call_id DESC
    LIMIT 1`
  const row = rows[0]
  if (row === undefined) return undefined
  return (yield* loadFullResult(row.result_json)).content
})

export const makeHandlerToolResults = ({
  writer
}: Pick<AutomationStoreDeps, "writer">): Pick<AutomationQueue["Service"], "handlerToolResult"> => ({
  handlerToolResult: (input) =>
    writer
      .withToolResults(handlerToolContent(writer.sql, input))
      .pipe(
        Effect.mapError((cause) =>
          storeError(
            "observe_chat_run",
            cause._tag === STORED_TOOL_RESULT_ERROR_TAG &&
              cause.reason === STORED_TOOL_RESULT_REASON.corrupt
              ? "corrupt"
              : "storage",
            "Could not read the run's result",
            undefined,
            cause
          )
        )
      )
})
