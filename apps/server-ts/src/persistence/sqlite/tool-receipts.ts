import { stripChangeEvidence } from "../tools/change-evidence.js"
import { descendantCalls, detachedWorkflowCalls } from "./detached-workflow-calls.js"
import { withChangeEvidence, refreshChangeEvidence } from "./change-evidence.js"
import type { ToolResult } from "@arden-hq/loop"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { UnitOfWork } from "../unit-of-work.js"
import { JsonObjectSchema, type JsonObject } from "../json.js"
import { ToolExecutionStoreError, type ToolExecutionIdentity } from "../tools/store.js"
import { attachMutationReceipt, ensureMutationReceipt } from "../tools/mutation-receipt.js"
import { decodeJson, encodeJson } from "./json.js"
import {
  type ToolOperation,
  type ChatRunRow,
  type UpdatedToolRow,
  resultEquivalent,
  canonicalToolArguments,
  toolError,
  decodeIdentity,
  decodeResult,
  decodeStoredResult,
  requireRow
} from "./tool-rows.js"
import {
  loadFullResult,
  resultDigest,
  storedResultDigest,
  storedResultJson,
  withoutChangeEvidence,
  type PersistedToolResult,
  type StoredToolResultError
} from "./tool-result-storage.js"
import type { ManagedObjectDescriptor } from "../managed-output/descriptor.js"
import {
  answeredApprovalStatusList,
  outToolStatusList,
  resultToolStatusList,
  waitingToolStatusList
} from "./status-sets.js"

interface SettledRunToolRow {
  readonly tool_call_id: string
  readonly tool_name: string
  readonly arguments_json: string
  readonly changes_state: number
  readonly result_json: string
  readonly ended_at: string
  readonly confirmed_outcome: number
}

interface UnstartedTerminalToolRow {
  readonly tool_call_id: string
  readonly changes_state: number
}

export interface SettledRunToolExecution {
  readonly toolCallId: string
  readonly toolName: string
  readonly arguments: JsonObject
  readonly changesState: boolean
  readonly endedAt: string
  readonly result: ToolResult
  readonly confirmedOutcome: boolean
}

const withoutApprovalFact = (result: PersistedToolResult): PersistedToolResult => {
  if (result.data === undefined || result.data === null || !("approval" in result.data))
    return result
  const { approval: _approval, ...data } = result.data
  return { ...result, data }
}

const storageError =
  (operation: ToolOperation, identity: Pick<ToolExecutionIdentity, "runId" | "toolCallId">) =>
  (cause: StoredToolResultError): ToolExecutionStoreError =>
    toolError(
      operation,
      cause.reason === "corrupt" ? "corrupt" : "storage",
      cause.message,
      identity,
      cause
    )

export const requireRunningToolExecutionInTransaction = Effect.fn(
  "SqliteToolExecutionStore.requireRunningInTransaction"
)(function* (
  sql: SqlClient.SqlClient,
  input: ToolExecutionIdentity
): Effect.fn.Return<void, ToolExecutionStoreError> {
  const identity = yield* decodeIdentity(input, "complete")
  const current = yield* requireRow(sql, identity, "complete")
  if (current.status !== "running") {
    return yield* toolError("complete", "conflict", "Tool execution is not running", identity)
  }
})

export const settleToolExecutionInTransaction = Effect.fn(
  "SqliteToolExecutionStore.settleInTransaction"
)(function* (
  sql: SqlClient.SqlClient,
  input: ToolExecutionIdentity,
  inputResult: ToolResult,
  endedAt: string,
  options: {
    readonly published?: ManagedObjectDescriptor | undefined
  } = {}
): Effect.fn.Return<ToolResult, ToolExecutionStoreError> {
  const identity = yield* decodeIdentity(input, "complete")
  const result = yield* decodeResult(
    identity.changesState
      ? yield* withChangeEvidence(
          sql,
          identity,
          ensureMutationReceipt(identity, stripChangeEvidence(inputResult))
        ).pipe(
          Effect.mapError((cause) =>
            toolError("complete", "storage", "Could not read mutation evidence", identity, cause)
          )
        )
      : stripChangeEvidence(inputResult),
    "complete",
    identity
  )
  const resultJson = yield* storedResultJson(result, options.published).pipe(
    Effect.mapError((cause) =>
      toolError("complete", "invalid", "Tool result must be JSON-safe", identity, cause)
    )
  )
  const current = yield* requireRow(sql, identity, "complete")
  if (current.status === "completed") {
    const sameDigest =
      current.row.result_json !== null &&
      storedResultDigest(current.row.result_json) === resultDigest(result)
    const stored = sameDigest
      ? result
      : yield* decodeStoredResult(current.row, identity, "complete")
    if (resultEquivalent(withoutChangeEvidence(stored), withoutChangeEvidence(result))) {
      return identity.changesState
        ? yield* withChangeEvidence(sql, identity, stored).pipe(
            Effect.mapError((cause) =>
              toolError(
                "complete",
                "storage",
                "Could not refresh mutation evidence",
                identity,
                cause
              )
            )
          )
        : stripChangeEvidence(stored)
    }
    if (
      !resultEquivalent(
        withoutChangeEvidence(withoutApprovalFact(stored)),
        withoutChangeEvidence(withoutApprovalFact(result))
      )
    ) {
      return yield* toolError(
        "complete",
        "conflict",
        "Tool execution already has a different result",
        identity
      )
    }
    yield* sql`
      UPDATE tool_calls SET result_json = ${resultJson}
      WHERE run_id = ${identity.runId} AND tool_call_id = ${identity.toolCallId}
        AND status = 'completed'
    `.pipe(
      Effect.mapError((cause) =>
        toolError("complete", "storage", "Could not record the approval fact", identity, cause)
      )
    )
    return result
  }
  if (current.status === "paused" || current.status === "ready") {
    return yield* toolError("complete", "conflict", "Tool execution is not running", identity)
  }
  if (current.status === "uncertain") {
    const runs = yield* sql<ChatRunRow>`
      SELECT status FROM chat_runs
      WHERE run_id = ${identity.runId} AND session_id = ${identity.sessionId}
      LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        toolError("complete", "storage", "Could not read the owning chat run", identity, cause)
      )
    )
    if (!runs[0]) {
      return yield* toolError(
        "complete",
        "conflict",
        "The owning chat run no longer exists",
        identity
      )
    }
  }
  const updated = yield* sql<UpdatedToolRow>`
    UPDATE tool_calls
    SET status = 'completed', result_json = ${resultJson}, ended_at = ${endedAt}
    WHERE run_id = ${identity.runId} AND tool_call_id = ${identity.toolCallId}
      AND status IN ${outToolStatusList}
    RETURNING status
  `.pipe(
    Effect.mapError((cause) =>
      toolError("complete", "storage", "Could not complete tool execution", identity, cause)
    )
  )
  if (updated.length !== 1) {
    return yield* toolError(
      "complete",
      "conflict",
      "Tool execution changed before completion",
      identity
    )
  }
  return result
})

export const loadSettledRunToolExecutionsInTransaction = Effect.fn(
  "SqliteToolExecutionStore.loadSettledRunToolExecutionsInTransaction"
)(function* (
  sql: SqlClient.SqlClient,
  runId: string
): Effect.fn.Return<ReadonlyArray<SettledRunToolExecution>, ToolExecutionStoreError> {
  const rows = yield* sql<SettledRunToolRow>`
    SELECT call.tool_call_id, call.tool_name, call.arguments_json, call.changes_state,
           call.result_json, call.ended_at,
           EXISTS (
             SELECT 1 FROM tool_approvals AS approval
             WHERE approval.run_id = call.run_id AND approval.tool_call_id = call.tool_call_id
               AND approval.kind = 'tool_outcome' AND approval.status IN ${answeredApprovalStatusList}
           ) AS confirmed_outcome
    FROM tool_calls AS call
    WHERE call.run_id = ${runId}
      AND call.status IN ${resultToolStatusList}
      AND call.result_json IS NOT NULL
      AND call.ended_at IS NOT NULL
    ORDER BY call.started_at, call.tool_call_id
  `.pipe(
    Effect.mapError((cause) =>
      toolError("recover", "storage", "Could not load settled tool executions", undefined, cause)
    )
  )

  return yield* Effect.forEach(rows, (row) => decodeSettledRunToolRow(sql, runId, row))
})

const decodeSettledRunToolRow = Effect.fn("SqliteToolExecutionStore.decodeSettledRunToolRow")(
  function* (
    sql: SqlClient.SqlClient,
    runId: string,
    row: SettledRunToolRow
  ): Effect.fn.Return<SettledRunToolExecution, ToolExecutionStoreError> {
    const identity = { runId, toolCallId: row.tool_call_id }
    const arguments_ = yield* decodeJson(JsonObjectSchema, row.arguments_json).pipe(
      Effect.mapError((cause) =>
        toolError(
          "recover",
          "corrupt",
          "Stored settled tool arguments are corrupt",
          identity,
          cause
        )
      )
    )
    if (row.changes_state !== 0 && row.changes_state !== 1) {
      return yield* toolError(
        "recover",
        "corrupt",
        "Stored settled tool mutation identity is corrupt",
        identity
      )
    }
    const result = yield* loadFullResult(row.result_json).pipe(
      Effect.mapError(storageError("recover", identity))
    )
    return {
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      arguments: canonicalToolArguments(row.tool_name, arguments_),
      changesState: row.changes_state === 1,
      endedAt: row.ended_at,
      result: yield* refreshChangeEvidence(
        sql,
        { ...identity, changesState: row.changes_state === 1 },
        result
      ).pipe(
        Effect.mapError((cause) =>
          toolError("recover", "storage", "Could not refresh mutation evidence", identity, cause)
        )
      ),
      confirmedOutcome: row.confirmed_outcome === 1
    } satisfies SettledRunToolExecution
  }
)

export const RUN_END_APPROVAL_FEEDBACK: Record<"cancelled" | "ended", string> = {
  cancelled: "The run was cancelled before this was answered",
  ended: "The run ended before this was answered"
}

export const settleUnstartedToolWorkForTerminalInTransaction = Effect.fn(
  "SqliteToolExecutionStore.settleUnstartedToolWorkForTerminalInTransaction"
)(function* (
  sql: SqlClient.SqlClient,
  runId: string,
  endedAt: string,
  terminal: "cancelled" | "failed" | "completed",
  owner?: { readonly scriptToolCallId: string }
): Effect.fn.Return<void, ToolExecutionStoreError, UnitOfWork> {
  const scope =
    owner === undefined
      ? sql`1 = 1`
      : sql`tool_call_id IN ${descendantCalls(sql, runId, owner.scriptToolCallId)}`
  const rows = yield* sql<UnstartedTerminalToolRow>`
    SELECT tool_call_id, changes_state
    FROM tool_calls
    WHERE run_id = ${runId} AND status IN ${waitingToolStatusList} AND ${scope}
    ORDER BY started_at, tool_call_id
  `.pipe(
    Effect.mapError((cause) =>
      toolError(
        "uncertain",
        "storage",
        "Could not list unstarted terminal tool executions",
        undefined,
        cause
      )
    )
  )
  const detached =
    owner === undefined
      ? yield* detachedWorkflowCalls(
          sql,
          runId,
          rows.map((row) => row.tool_call_id)
        ).pipe(
          Effect.mapError((cause) =>
            toolError(
              "uncertain",
              "storage",
              "Could not read the detached script owners",
              undefined,
              cause
            )
          )
        )
      : new Set<string>()
  const settling = rows.filter((row) => !detached.has(row.tool_call_id))
  for (const row of settling) {
    const identity = { runId, toolCallId: row.tool_call_id }
    const base: ToolResult = {
      content:
        terminal === "cancelled"
          ? "The tool was not executed because the assistant run was cancelled."
          : "The tool was not executed because the assistant run ended.",
      preview: terminal === "cancelled" ? "Tool execution cancelled" : "Tool execution stopped",
      is_error: true,
      retryable: false,
      data: {
        outcome: `${terminal}_before_execution`
      }
    }
    const result = yield* decodeResult(
      row.changes_state === 1
        ? attachMutationReceipt(base, {
            identity,
            outcome: "no_op",
            resource: { kind: "none" }
          })
        : base,
      "uncertain",
      identity
    )
    const resultJson = yield* storedResultJson(result, undefined).pipe(
      Effect.mapError((cause) =>
        toolError("uncertain", "corrupt", "Terminal tool result is invalid", identity, cause)
      )
    )
    const updated = yield* sql<UpdatedToolRow>`
      UPDATE tool_calls
      SET status = 'completed', result_json = ${resultJson}, ended_at = ${endedAt}
      WHERE run_id = ${runId} AND tool_call_id = ${row.tool_call_id}
        AND status IN ${waitingToolStatusList}
      RETURNING status
    `.pipe(
      Effect.mapError((cause) =>
        toolError(
          "uncertain",
          "storage",
          "Could not settle unstarted terminal tool execution",
          identity,
          cause
        )
      )
    )
    if (updated.length !== 1) {
      return yield* toolError(
        "uncertain",
        "conflict",
        "Unstarted tool execution changed before terminal settlement",
        identity
      )
    }
  }
  if (settling.length === 0) return
  const feedback =
    owner === undefined
      ? RUN_END_APPROVAL_FEEDBACK[terminal === "cancelled" ? "cancelled" : "ended"]
      : "The script was cancelled before this was answered"
  const resolutionJson = yield* encodeJson(JsonObjectSchema, {
    approved: false,
    feedback
  }).pipe(
    Effect.mapError((cause) =>
      toolError("uncertain", "corrupt", "Terminal approval resolution is invalid", undefined, cause)
    )
  )
  yield* sql`
    UPDATE tool_approvals
    SET status = 'rejected', resolved_at = ${endedAt},
        result_feedback = ${feedback},
        resolution_json = ${resolutionJson}
    WHERE run_id = ${runId} AND kind = 'tool_approval' AND status = 'pending'
      AND tool_call_id IN ${sql.in(settling.map((row) => row.tool_call_id))}
  `.pipe(
    Effect.mapError((cause) =>
      toolError("uncertain", "storage", "Could not settle pending tool approvals", undefined, cause)
    )
  )
})
