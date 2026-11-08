import { isLastingRunError } from "@arden-hq/protocol/chat"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { activeRunStatusList } from "./status-sets.js"

interface LastEndedRun {
  readonly status: string
  readonly errorCode: string | null
  readonly modelId: string | null
}

export const holdsUnattendedInput = (
  last: LastEndedRun | undefined,
  modelId: string | null
): boolean =>
  last !== undefined &&
  last.status === "error" &&
  isLastingRunError(last.errorCode) &&
  last.modelId === modelId

export const readLastEndedRun = Effect.fn("ChatHold.readLastEndedRun")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string
) {
  const rows = yield* sql<{
    readonly status: string
    readonly error_code: string | null
    readonly model_id: string | null
  }>`
    SELECT status, error_code, model_id FROM chat_runs
    WHERE session_id = ${sessionId} AND status NOT IN ${activeRunStatusList}
    ORDER BY updated_at DESC, started_at DESC, run_id DESC
    LIMIT 1
  `
  const row = rows[0]
  return row === undefined
    ? undefined
    : { status: row.status, errorCode: row.error_code, modelId: row.model_id }
})
