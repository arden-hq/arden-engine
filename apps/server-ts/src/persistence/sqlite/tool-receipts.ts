import { stripChangeEvidence } from "../tools/change-evidence.js"
import { detachedWorkflowCalls } from "./detached-workflow-calls.js"
import { withChangeEvidence, refreshChangeEvidence } from "./change-evidence.js"
import type { ToolResult } from "@arden-hq/loop"
import { DateTime, Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { UnitOfWork } from "../unit-of-work.js"
import { JsonObjectSchema, type JsonObject } from "../json.js"
import {
  ToolExecutionStoreError,
  UNCERTAIN_TOOL_RESULT,
  type ToolExecutionIdentity,
  type ToolExecutionOutcome
} from "../tools/store.js"
import {
  attachMutationReceipt,
  ensureMutationReceipt,
  makeMutationReceipt
} from "../tools/mutation-receipt.js"
import { decodeJson, encodeJson } from "./json.js"
import {
  type ToolOperation,
  type ValidToolExecutionIdentity,
  type ChatRunRow,
  type UpdatedToolRow,
  type LoadedToolRow,
  PersistedToolResultSchema,
  type PersistedToolResult,
  resultEquivalent,
  canonicalToolArguments,
  toolError,
  decodeIdentity,
  decodeResult,
  decodeStoredResult,
  requireRow
} from "./tool-rows.js"
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

const withoutChangeEvidence = (result: PersistedToolResult): PersistedToolResult => {
  const { change_evidence: _evidence, ...data } = result.data ?? {}
  const { data: _data, ...rest } = result
  return { ...rest, ...(Object.keys(data).length === 0 ? {} : { data }) }
}

const withoutApprovalFact = (result: PersistedToolResult): PersistedToolResult => {
  if (result.data === undefined || result.data === null || !("approval" in result.data))
    return result
  const { approval: _approval, ...data } = result.data
  return { ...result, data }
}

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
  endedAt: string
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
  const resultJson = yield* encodeJson(PersistedToolResultSchema, result).pipe(
    Effect.mapError((cause) =>
      toolError("complete", "invalid", "Tool result must be JSON-safe", identity, cause)
    )
  )
  const current = yield* requireRow(sql, identity, "complete")
  if (current.status === "completed") {
    const stored = yield* decodeStoredResult(current.row, identity, "complete")
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

export const settleUncertainRow = Effect.fn("SqliteToolExecutionStore.settleUncertainRow")(
  function* (
    sql: SqlClient.SqlClient,
    identity: ValidToolExecutionIdentity,
    operation: "uncertain" | "recover",
    current: LoadedToolRow
  ): Effect.fn.Return<ToolExecutionOutcome, ToolExecutionStoreError> {
    const result = uncertainToolResult(identity)
    if (current.status === "completed") {
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
    if (current.status === "uncertain") {
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
    if (current.status === "paused") {
      return yield* toolError(
        operation,
        "blocked",
        "Paused tool execution requires an approval decision",
        identity
      )
    }
    if (current.status === "ready") {
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
  encodeJson(PersistedToolResultSchema, uncertainToolResult(identity)).pipe(
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

export type RunEnding = "run_ended" | "process_restarted"

const scriptCalls = (
  sql: SqlClient.SqlClient,
  runId: string,
  toolCallIds: ReadonlyArray<string>,
  ending: RunEnding
): Effect.Effect<ReadonlySet<string>, ToolExecutionStoreError> =>
  ending === "process_restarted"
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
    const result = yield* decodeJson(PersistedToolResultSchema, row.result_json).pipe(
      Effect.mapError((cause) =>
        toolError("recover", "corrupt", "Stored settled tool result is corrupt", identity, cause)
      )
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

export const RUN_END_APPROVAL_FEEDBACK = {
  cancelled: "The run was cancelled before this was answered",
  ended: "The run ended before this was answered"
} as const

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
      : sql`substr(tool_call_id, 1, ${owner.scriptToolCallId.length + 1}) = ${`${owner.scriptToolCallId}:`}`
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
    const resultJson = yield* encodeJson(PersistedToolResultSchema, result).pipe(
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
