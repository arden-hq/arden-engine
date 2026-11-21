import { Effect, Option, Schema } from "effect"
import type { AutomationQueue, HandlerToolName } from "../automations/queue.js"
import type { AutomationStoreDeps } from "./automation-rows.js"
import { storeError } from "./automation-rows.js"
import { PersistedToolResultSchema } from "./tool-result-storage.js"

const decodeResult = Schema.decodeUnknownOption(Schema.fromJsonString(PersistedToolResultSchema))

export const makeHandlerToolResults = ({
  writer
}: Pick<AutomationStoreDeps, "writer">): Pick<AutomationQueue["Service"], "handlerToolResult"> => {
  const sql = writer.sql
  const handlerToolResult = Effect.fn("SqliteAutomationStore.handlerToolResult")(function* (input: {
    readonly runId: string
    readonly tool: HandlerToolName
  }) {
    const rows = yield* sql<{ readonly result_json: string }>`
      SELECT result_json FROM tool_calls
      WHERE run_id = ${input.runId} AND tool_name = ${input.tool} AND status = 'completed'
        AND COALESCE(json_extract(result_json, '$.is_error'), 0) = 0
      ORDER BY ended_at DESC, tool_call_id DESC
      LIMIT 1`.pipe(
      Effect.mapError((cause) =>
        storeError(
          "observe_chat_run",
          "storage",
          "Could not read the run's result",
          undefined,
          cause
        )
      )
    )
    const row = rows[0]
    if (row === undefined) return undefined
    const result = decodeResult(row.result_json)
    if (Option.isNone(result))
      return yield* storeError("observe_chat_run", "corrupt", "The run's stored result is corrupt")
    return result.value.content
  })
  return { handlerToolResult }
}
