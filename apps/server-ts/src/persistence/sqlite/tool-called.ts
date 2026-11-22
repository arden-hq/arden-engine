import { Effect } from "effect"
import type { ToolHistoryQueries } from "../tools/history-queries.js"
import type { PersistenceDeps } from "./deps.js"
import { toolError } from "./tool-rows.js"

export const makeCalledTool = ({
  writer
}: Pick<PersistenceDeps, "writer">): ToolHistoryQueries["Service"]["calledTool"] =>
  Effect.fn("SqliteToolExecutionStore.calledTool")(function* (input: {
    readonly runId: string
    readonly toolCallId: string
  }) {
    const rows = yield* writer.sql<{ readonly tool_name: string }>`
      SELECT tool_name FROM tool_calls
      WHERE run_id = ${input.runId} AND tool_call_id = ${input.toolCallId}
      LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        toolError("resolve", "storage", "Could not read the tool call", input, cause)
      )
    )
    return rows[0]?.tool_name
  })
