import { TOOL_STATUS } from "./status-sets.js"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { ToolExecutionStore } from "../tools/store.js"
import type { PersistenceDeps } from "./deps.js"
import { descendantCalls } from "./detached-workflow-calls.js"
import {
  decodeIdentity,
  preserveToolError,
  requireRow,
  toolError,
  type UpdatedToolRow,
  type ValidToolExecutionIdentity
} from "./tool-rows.js"

export const makeToolCoordinatorSuspend = ({
  writer
}: Pick<PersistenceDeps, "writer">): ToolExecutionStore["Service"]["suspend"] =>
  Effect.fn("SqliteToolExecutionStore.suspend")(function* (input, nestedToolCallId) {
    const identity = yield* decodeIdentity(input, "pause")
    const sql = writer.sql
    const nested = identity.changesState
      ? []
      : yield* sql`SELECT 1 AS present
          WHERE ${nestedToolCallId} IN ${descendantCalls(sql, identity.runId, identity.toolCallId)}`.pipe(
          Effect.mapError(preserveToolError("pause", identity))
        )
    if (nested.length === 0) {
      return yield* toolError(
        "pause",
        "invalid",
        "Only a coordinator can suspend on its nested call",
        identity
      )
    }
    yield* writer
      .transactInteractive(
        Effect.gen(function* () {
          const row = yield* requireRow(sql, identity, "pause")
          if (row.status !== TOOL_STATUS.running && row.status !== TOOL_STATUS.ready) {
            return yield* toolError(
              "pause",
              "conflict",
              "The coordinator is no longer running",
              identity
            )
          }
          const pending = yield* sql<{ readonly present: number }>`
          SELECT 1 AS present FROM tool_approvals
          WHERE run_id = ${identity.runId} AND tool_call_id = ${nestedToolCallId}
            AND status = 'pending'
          LIMIT 1
        `
          if (pending.length !== 1) {
            return yield* toolError(
              "pause",
              "conflict",
              "The nested decision is not pending",
              identity
            )
          }
          yield* sql`UPDATE tool_calls SET status = 'ready', ended_at = NULL
          WHERE run_id = ${identity.runId} AND tool_call_id = ${identity.toolCallId}
            AND status = 'running'`
        })
      )
      .pipe(Effect.mapError(preserveToolError("pause", identity)))
  })

export const resumeToolCoordinator = Effect.fn("SqliteToolExecutionStore.resumeCoordinator")(
  function* (sql: SqlClient.SqlClient, identity: ValidToolExecutionIdentity) {
    if (identity.changesState) {
      return yield* toolError(
        "begin",
        "corrupt",
        "A state-changing call has no approval decision",
        identity
      )
    }
    const decisions = yield* sql<{ readonly total: number; readonly pending: number }>`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending
      FROM tool_approvals
      WHERE run_id = ${identity.runId}
        AND tool_call_id IN ${descendantCalls(sql, identity.runId, identity.toolCallId)}
    `
    if (decisions[0]?.total === 0 || decisions[0]?.pending !== 0) {
      return yield* toolError(
        "begin",
        "conflict",
        "The coordinator's nested decisions are unresolved",
        identity
      )
    }
    const updated = yield* sql<UpdatedToolRow>`UPDATE tool_calls SET status = 'running'
      WHERE run_id = ${identity.runId} AND tool_call_id = ${identity.toolCallId}
        AND status = 'ready' RETURNING status`
    if (updated.length !== 1) {
      return yield* toolError(
        "begin",
        "conflict",
        "The coordinator changed before resume",
        identity
      )
    }
  }
)
