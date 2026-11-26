import { TOOL_STATUS } from "./status-sets.js"
import { detachedWorkflowCalls } from "./detached-workflow-calls.js"
import { refreshChangeEvidence } from "./change-evidence.js"
import { DateTime, Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  ToolExecutionStoreError,
  UNCERTAIN_TOOL_RESULT,
  type ToolExecutionIdentity,
  type ToolExecutionOutcome
} from "../tools/store.js"
import { makeMutationReceipt } from "../tools/mutation-receipt.js"
import {
  type ToolOperation,
  type ValidToolExecutionIdentity,
  type UpdatedToolRow,
  type LoadedToolRow,
  resultEquivalent,
  toolError,
  decodeStoredResult
} from "./tool-rows.js"
import {
  storedResultJson,
  withoutChangeEvidence,
  type PersistedToolResult
} from "./tool-result-storage.js"

export const settleUncertainRow = Effect.fn("SqliteToolExecutionStore.settleUncertainRow")(
  function* (
    sql: SqlClient.SqlClient,
    identity: ValidToolExecutionIdentity,
    operation: "uncertain" | "recover",
    current: LoadedToolRow
  ): Effect.fn.Return<ToolExecutionOutcome, ToolExecutionStoreError> {
    const result = uncertainToolResult(identity)
    if (current.status === TOOL_STATUS.completed) {
      const stored = yield* decodeStoredResult(current.row, identity, operation)
      return {
        status: "completed",
        result: yield* refreshChangeEvidence(sql, identity, stored).pipe(
          Effect.mapError((cause) =>
            toolError(operation, "storage", "Could not refresh mutation evidence", identity, cause)
          )
        )
      }
    }
    if (current.status === TOOL_STATUS.uncertain) {
      const stored = yield* decodeStoredResult(current.row, identity, operation)
      if (!resultEquivalent(withoutChangeEvidence(stored), withoutChangeEvidence(result))) {
        return yield* toolError(
          operation,
          "corrupt",
          "Stored uncertain result is invalid",
          identity
        )
      }
      return {
        status: "uncertain",
        result: yield* refreshChangeEvidence(sql, identity, stored).pipe(
          Effect.mapError((cause) =>
            toolError(operation, "storage", "Could not refresh mutation evidence", identity, cause)
          )
        )
      }
    }
    if (current.status === TOOL_STATUS.paused) {
      return yield* toolError(
        operation,
        "blocked",
        "Paused tool execution requires an approval decision",
        identity
      )
    }
    if (current.status === TOOL_STATUS.ready) {
      return yield* toolError(
        operation,
        "blocked",
        "Approved tool execution is waiting to resume",
        identity
      )
    }

    const resultJson = yield* uncertainResultJson(operation, identity)
    const endedAt = DateTime.formatIso(yield* DateTime.now)
    const updated = yield* sql<UpdatedToolRow>`
    UPDATE tool_calls
    SET status = 'uncertain', result_json = ${resultJson}, ended_at = ${endedAt}
    WHERE run_id = ${identity.runId} AND tool_call_id = ${identity.toolCallId}
      AND status = 'running'
    RETURNING status
  `.pipe(
      Effect.mapError((cause) =>
        toolError(
          operation,
          "storage",
          "Could not record uncertain tool execution",
          identity,
          cause
        )
      )
    )
    if (updated.length !== 1) {
      return yield* toolError(
        operation,
        "conflict",
        "Tool execution changed before uncertainty was recorded",
        identity
      )
    }
    return {
      status: "uncertain",
      result: yield* refreshChangeEvidence(sql, identity, result).pipe(
        Effect.mapError((cause) =>
          toolError(operation, "storage", "Could not refresh mutation evidence", identity, cause)
        )
      )
    }
  }
)

type UncertainToolIdentity = Pick<ToolExecutionIdentity, "runId" | "toolCallId" | "changesState">

const uncertainToolResult = (identity?: UncertainToolIdentity): PersistedToolResult =>
  identity?.changesState === true
    ? {
        ...UNCERTAIN_TOOL_RESULT,
        host: {
          mutation_receipt: makeMutationReceipt({
            identity,
            outcome: "unconfirmed",
            resource: { kind: "none" }
          })
        }
      }
    : UNCERTAIN_TOOL_RESULT

const uncertainResultJson = (operation: ToolOperation, identity?: UncertainToolIdentity) =>
  storedResultJson(uncertainToolResult(identity), undefined).pipe(
    Effect.mapError((cause) =>
      toolError(operation, "corrupt", "Uncertain tool result is invalid", undefined, cause)
    )
  )

const writeMutationUncertaintyReceipts = Effect.fn(
  "SqliteToolExecutionStore.writeMutationUncertaintyReceipts"
)(function* (
  sql: SqlClient.SqlClient,
  runId: string,
  rows: ReadonlyArray<{ readonly tool_call_id: string }>
): Effect.fn.Return<void, ToolExecutionStoreError> {
  for (const row of rows) {
    const identity = { runId, toolCallId: row.tool_call_id, changesState: true }
    const resultJson = yield* uncertainResultJson("uncertain", identity)
    const updated = yield* sql<UpdatedToolRow>`
      UPDATE tool_calls
      SET result_json = ${resultJson}
      WHERE run_id = ${runId} AND tool_call_id = ${row.tool_call_id}
        AND changes_state = 1 AND status = 'uncertain'
      RETURNING status
    `.pipe(
      Effect.mapError((cause) =>
        toolError(
          "uncertain",
          "storage",
          "Could not record mutation uncertainty receipt",
          identity,
          cause
        )
      )
    )
    if (updated.length !== 1) {
      return yield* toolError(
        "uncertain",
        "conflict",
        "Mutation execution changed before its uncertainty receipt was recorded",
        identity
      )
    }
  }
})

const RUN_ENDING = { ended: "run_ended", restarted: "process_restarted" } as const
export type RunEnding = (typeof RUN_ENDING)[keyof typeof RUN_ENDING]

const scriptCalls = (
  sql: SqlClient.SqlClient,
  runId: string,
  toolCallIds: ReadonlyArray<string>,
  ending: RunEnding
): Effect.Effect<ReadonlySet<string>, ToolExecutionStoreError> =>
  ending === RUN_ENDING.restarted
    ? Effect.succeed(new Set())
    : detachedWorkflowCalls(sql, runId, toolCallIds).pipe(
        Effect.mapError((cause) =>
          toolError(
            "uncertain",
            "storage",
            "Could not read which calls a background script owns",
            undefined,
            cause
          )
        )
      )

export const markRunToolExecutionsUncertainInTransaction = Effect.fn(
  "SqliteToolExecutionStore.markRunToolExecutionsUncertainInTransaction"
)(function* (
  sql: SqlClient.SqlClient,
  runId: string,
  endedAt: string,
  ending: RunEnding
): Effect.fn.Return<void, ToolExecutionStoreError> {
  const running = yield* sql<{ readonly tool_call_id: string; readonly changes_state: number }>`
    SELECT tool_call_id, changes_state
    FROM tool_calls
    WHERE run_id = ${runId} AND status = 'running'
  `.pipe(
    Effect.mapError((cause) =>
      toolError("uncertain", "storage", "Could not list running tool executions", undefined, cause)
    )
  )
  const scripts = yield* scriptCalls(
    sql,
    runId,
    running.map((row) => row.tool_call_id),
    ending
  )
  const settled = running.filter((row) => !scripts.has(row.tool_call_id))
  if (settled.length === 0) return
  const resultJson = yield* uncertainResultJson("uncertain")
  yield* sql`
    UPDATE tool_calls
    SET status = 'uncertain', result_json = ${resultJson}, ended_at = ${endedAt}
    WHERE run_id = ${runId} AND status = 'running'
      AND tool_call_id IN ${sql.in(settled.map((row) => row.tool_call_id))}
  `.pipe(
    Effect.mapError((cause) =>
      toolError(
        "uncertain",
        "storage",
        "Could not settle running tool executions",
        undefined,
        cause
      )
    )
  )
  yield* writeMutationUncertaintyReceipts(
    sql,
    runId,
    settled.filter((row) => row.changes_state === 1)
  )
})
