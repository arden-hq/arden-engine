import { resultDataEntry } from "../runs/stored-question-data.js"
import { refreshChangeEvidence, withNestedCallFacts, withScriptState } from "./change-evidence.js"
import { CODE_MODE_TOOL, SPAWN_AGENT_TOOL, nestedCallNesting } from "../tools/tool-roles.js"
import type { RuntimeApprovalSnapshot } from "@arden-hq/protocol/chat"
import { Effect, Option, Schema } from "effect"
import type { PendingConnectionDecision } from "../../connections/recovery.js"
import type {
  ToolHistoryQueries,
  AgentAssignment,
  LedgerToolCall,
  LedgerToolCallInput,
  ToolExecutionHistoryInput,
  ToolExecutionResultMetadata
} from "../tools/history-queries.js"
import { ToolExecutionStore, ToolExecutionStoreError } from "../tools/store.js"
import { decodeJson } from "./json.js"
import { pendingDecisionCards, visiblePendingDecisionCards } from "./pending-decision-cards.js"
import type { PersistenceDeps } from "./deps.js"
import { type ApprovalRow, toolError, decodePendingConnection } from "./tool-rows.js"
import { resultToolStatusList } from "./status-sets.js"
import {
  loadFullResult,
  OMITTING_ROW_SQL,
  PersistedToolResultSchema,
  withWholeDataAndHost
} from "./tool-result-storage.js"
import {
  decodePendingApprovals,
  descendantSessionIds,
  indexedVisibilityReady,
  legacySideOutcomeRows,
  orderedDecisionRows,
  validDescendantSessionIds,
  validatePendingLineage
} from "./tool-pending-support.js"
import { makePendingConnections } from "./tool-pending-connections.js"

interface ToolHistoryResultRow {
  readonly run_id: string
  readonly changes_state: number
  readonly tool_call_id: string
  readonly tool_name: string
  readonly result_json: string
  readonly omitting_json: string | null
  readonly started_at: string
  readonly ended_at: string | null
}

const ToolExecutionHistoryInputSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  toolCallIds: Schema.Array(Schema.NonEmptyString)
})

const PendingConnectionLookupSchema = Schema.Struct({
  runId: Schema.NonEmptyString,
  toolCallId: Schema.NonEmptyString
})

const ToolHistoryMetadataSchema = Schema.Struct({
  is_error: PersistedToolResultSchema.fields.is_error,
  retryable: PersistedToolResultSchema.fields.retryable,
  data: PersistedToolResultSchema.fields.data,
  host: PersistedToolResultSchema.fields.host
})

export const makeToolHistory = ({
  reader,
  writer
}: Pick<PersistenceDeps, "reader" | "writer">): {
  readonly history: Omit<ToolHistoryQueries["Service"], "calledTool">
} & Pick<
  ToolExecutionStore["Service"],
  "priorResults" | "pendingConnection" | "allPendingConnections"
> => {
  const sql = writer.sql
  const historySql = reader
  const { pendingConnections, allPendingConnections, pendingDescendantConnections } =
    makePendingConnections({ sql, historySql })
  const agentAssignment = Effect.fn("SqliteToolExecutionStore.agentAssignment")(function* (
    sessionId: string
  ): Effect.fn.Return<AgentAssignment | undefined, ToolExecutionStoreError> {
    const rows = yield* historySql<AgentAssignment>`
      SELECT parent.public_ref AS fromSessionRef, child.public_ref AS toSessionRef,
             call.tool_call_id AS toolCallId,
             json_extract(call.arguments_json, '$.task') AS task
      FROM sessions AS child
      JOIN sessions AS parent ON parent.session_id = child.parent_session_id
      JOIN tool_calls AS call ON call.run_id = child.parent_run_id
        AND call.session_id = parent.session_id
        AND call.tool_call_id = child.parent_tool_call_id
      WHERE child.session_id = ${sessionId} AND child.session_type = 'agent'
        AND call.tool_name = ${SPAWN_AGENT_TOOL}
        AND json_type(call.arguments_json, '$.task') = 'text'
      LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        toolError("history", "storage", "Could not read the agent's assignment", undefined, cause)
      )
    )
    const assignment = rows[0]
    return assignment === undefined ? undefined : { ...assignment, task: assignment.task.trim() }
  })
  const priorResults = Effect.fn("SqliteToolExecutionStore.priorResults")(function* (input: {
    readonly sessionId: string
    readonly toolName: string
  }): Effect.fn.Return<
    ReadonlyArray<{ readonly runId: string; readonly data: Readonly<Record<string, unknown>> }>,
    ToolExecutionStoreError
  > {
    const rows = yield* sql<{ readonly run_id: string; readonly result_json: string }>`
      SELECT run_id, result_json
      FROM tool_calls
      WHERE session_id = ${input.sessionId}
        AND tool_name = ${input.toolName}
        AND status = 'completed'
        AND result_json IS NOT NULL
      ORDER BY started_at, tool_call_id
    `.pipe(
      Effect.mapError((cause) =>
        toolError("history", "storage", "Could not load prior tool results", undefined, cause)
      )
    )
    const results: Array<{ runId: string; data: Readonly<Record<string, unknown>> }> = []
    for (const row of rows) {
      const result = yield* writer
        .withToolResults(loadFullResult(row.result_json))
        .pipe(Effect.option)
      const data = Option.isSome(result) ? result.value.data : undefined
      if (data !== undefined && data !== null) results.push({ runId: row.run_id, data })
    }
    return results
  })

  const historyResultMetadata = Effect.fn("SqliteToolExecutionStore.historyResultMetadata")(
    function* (
      input: ToolExecutionHistoryInput
    ): Effect.fn.Return<ReadonlyMap<string, ToolExecutionResultMetadata>, ToolExecutionStoreError> {
      const decoded = yield* Schema.decodeUnknownEffect(ToolExecutionHistoryInputSchema)(input, {
        onExcessProperty: "error"
      }).pipe(
        Effect.mapError((cause) =>
          toolError("history", "invalid", "Invalid tool history lookup", undefined, cause)
        )
      )
      const toolCallIds = [...new Set(decoded.toolCallIds)]
      if (toolCallIds.length === 0) return new Map()

      const rows = yield* historySql<ToolHistoryResultRow>`
      SELECT run_id, tool_call_id, tool_name, changes_state,
             json_remove(result_json, '$.content', '$.preview', '$.model_content', '$.message_extras') AS result_json,
             ${historySql.literal(OMITTING_ROW_SQL)} AS omitting_json,
             started_at, ended_at
      FROM tool_calls
      WHERE session_id = ${decoded.sessionId}
        AND tool_call_id IN ${historySql.in(toolCallIds)}
        AND status IN ${resultToolStatusList}
        AND result_json IS NOT NULL
      ORDER BY started_at
    `.pipe(
        Effect.mapError((cause) =>
          toolError("history", "storage", "Could not read tool result metadata", undefined, cause)
        )
      )
      const entries = yield* Effect.forEach(
        rows,
        Effect.fn("SqliteToolExecutionStore.decodeHistoryResultMetadata")(function* (row) {
          const stored = yield* decodeJson(ToolHistoryMetadataSchema, row.result_json).pipe(
            Effect.mapError((cause) =>
              toolError(
                "history",
                "corrupt",
                "Stored tool result is corrupt",
                { runId: row.run_id, toolCallId: row.tool_call_id },
                cause
              )
            )
          )
          const result = yield* writer
            .withToolResults(withWholeDataAndHost(stored, row.omitting_json))
            .pipe(Effect.mapError((cause) => toolError("history", "storage", cause.message)))
          const projected = yield* refreshChangeEvidence(
            historySql,
            {
              runId: row.run_id,
              toolCallId: row.tool_call_id,
              changesState: row.changes_state === 1
            },
            { content: "", preview: "", ...result }
          ).pipe(
            Effect.flatMap((refreshed) => {
              const nesting = nestedCallNesting(row.tool_name)
              if (nesting === undefined) return Effect.succeed(refreshed)
              return withNestedCallFacts(
                historySql,
                { runId: row.run_id, toolCallId: row.tool_call_id },
                refreshed.data ?? {},
                nesting
              ).pipe(
                Effect.flatMap((data) =>
                  row.tool_name === CODE_MODE_TOOL
                    ? withScriptState(historySql, data)
                    : Effect.succeed(data)
                ),
                Effect.map((data) => ({ ...refreshed, data }))
              )
            }),
            Effect.mapError((cause) =>
              toolError("history", "storage", "Could not read mutation evidence", undefined, cause)
            )
          )
          const durationMs =
            row.ended_at === null
              ? undefined
              : Date.parse(row.ended_at) - Date.parse(row.started_at)
          return [
            row.tool_call_id,
            {
              isError: result.is_error === true,
              retryable: result.retryable ?? null,
              ...resultDataEntry(projected.data),
              ...(durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0
                ? {}
                : { durationMs })
            } satisfies ToolExecutionResultMetadata
          ] as const
        })
      )
      return new Map(entries)
    }
  )

  const ledgerToolCall = Effect.fn("SqliteToolExecutionStore.ledgerToolCall")(function* (
    input: LedgerToolCallInput
  ): Effect.fn.Return<LedgerToolCall | undefined, ToolExecutionStoreError> {
    const rows = yield* historySql<{
      readonly tool_name: string
      readonly arguments_json: string
      readonly result_json: string
    }>`
      SELECT call.tool_name, call.arguments_json, call.result_json
      FROM tool_calls AS call
      JOIN chat_runs AS run ON run.run_id = call.run_id AND run.session_id = call.session_id
      WHERE call.session_id = ${input.sessionId}
        AND call.tool_call_id = ${input.toolCallId}
        AND json_extract(run.metadata_json, '$.turn_id') = ${input.turnId}
        AND call.status IN ${resultToolStatusList}
      LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        toolError("history", "storage", "Could not read the tool call", undefined, cause)
      )
    )
    const row = rows[0]
    if (row === undefined) return undefined
    const result = yield* writer
      .withToolResults(loadFullResult(row.result_json))
      .pipe(
        Effect.mapError((cause) => toolError("history", "storage", cause.message, undefined, cause))
      )
    return {
      name: row.tool_name,
      arguments: row.arguments_json,
      result: result.content,
      isError: result.is_error === true
    }
  })

  const pendingApprovals = Effect.fn("SqliteToolExecutionStore.pendingApprovals")(function* (
    sessionId: string
  ): Effect.fn.Return<ReadonlyArray<RuntimeApprovalSnapshot>, ToolExecutionStoreError> {
    const validSessionId = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(sessionId).pipe(
      Effect.mapError((cause) =>
        toolError("pending_approvals", "invalid", "Invalid session id", undefined, cause)
      )
    )
    const rows = yield* historySql<ApprovalRow>`
      SELECT run_id, session_id, tool_call_id, tool_name, action, scope,
             preview, diff, status, requested_at, resolved_at, expires_at,
             result_feedback, kind, payload_json, resolution_json, source
      FROM (${pendingDecisionCards(historySql)})
      WHERE session_id = ${validSessionId}
        AND COALESCE(json_extract(payload_json, '$.approval_data._tag'), '') != 'ConnectionRequired'
      ORDER BY requested_at, run_id, tool_call_id
    `.pipe(
      Effect.mapError((cause) =>
        toolError(
          "pending_approvals",
          "storage",
          "Could not list pending tool approvals",
          undefined,
          cause
        )
      )
    )
    yield* validatePendingLineage(historySql, rows, "pending_approvals")
    return yield* decodePendingApprovals(rows)
  })

  const pendingDescendantApprovals = Effect.fn(
    "SqliteToolExecutionStore.pendingDescendantApprovals"
  )(function* (
    sessionId: string
  ): Effect.fn.Return<ReadonlyArray<RuntimeApprovalSnapshot>, ToolExecutionStoreError> {
    if (yield* indexedVisibilityReady(historySql, sessionId, "pending_approvals")) {
      const rows = yield* historySql<ApprovalRow>`
        SELECT run_id, session_id, tool_call_id, tool_name, action, scope,
               preview, diff, status, requested_at, resolved_at, expires_at,
               result_feedback, kind, payload_json, resolution_json, source, work_json
        FROM (${visiblePendingDecisionCards(historySql, sessionId)})
        WHERE session_id != ${sessionId}
          AND COALESCE(json_extract(payload_json, '$.approval_data._tag'), '') != 'ConnectionRequired'
        ORDER BY requested_at, run_id, tool_call_id, source
      `.pipe(
        Effect.mapError((cause) =>
          toolError(
            "pending_approvals",
            "storage",
            "Could not list pending tool approvals",
            undefined,
            cause
          )
        )
      )
      return yield* decodePendingApprovals(rows)
    }
    const descendantIds = yield* descendantSessionIds(historySql, sessionId)
    const ids = yield* validDescendantSessionIds(descendantIds, "pending_approvals")
    const sideRows = yield* legacySideOutcomeRows(historySql, sessionId, false)
    if (ids.length === 0) {
      yield* validatePendingLineage(historySql, sideRows, "pending_approvals")
      return yield* decodePendingApprovals(orderedDecisionRows(sideRows))
    }
    const rows = yield* historySql<ApprovalRow>`
      SELECT run_id, session_id, tool_call_id, tool_name, action, scope,
             preview, diff, status, requested_at, resolved_at, expires_at,
             result_feedback, kind, payload_json, resolution_json, source
      FROM (${pendingDecisionCards(historySql)})
      WHERE session_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
        AND COALESCE(json_extract(payload_json, '$.approval_data._tag'), '') != 'ConnectionRequired'
      ORDER BY session_id, requested_at, run_id, tool_call_id
    `.pipe(
      Effect.mapError((cause) =>
        toolError(
          "pending_approvals",
          "storage",
          "Could not list pending tool approvals",
          undefined,
          cause
        )
      )
    )
    yield* validatePendingLineage(historySql, [...rows, ...sideRows], "pending_approvals")
    return yield* decodePendingApprovals(orderedDecisionRows([...rows, ...sideRows]))
  })

  const pendingConnection = Effect.fn("SqliteToolExecutionStore.pendingConnection")(
    function* (input: {
      readonly runId: string
      readonly toolCallId: string
    }): Effect.fn.Return<PendingConnectionDecision | null, ToolExecutionStoreError> {
      const decoded = yield* Schema.decodeUnknownEffect(PendingConnectionLookupSchema)(input, {
        onExcessProperty: "error"
      }).pipe(
        Effect.mapError((cause) =>
          toolError(
            "pending_connections",
            "invalid",
            "Invalid pending connection lookup",
            input,
            cause
          )
        )
      )
      const rows = yield* sql<ApprovalRow>`
      SELECT run_id, session_id, tool_call_id, tool_name, action, scope,
             preview, diff, status, requested_at, resolved_at, expires_at,
             result_feedback, kind, payload_json, resolution_json, source
      FROM (${pendingDecisionCards(sql)})
      WHERE run_id = ${decoded.runId}
        AND tool_call_id = ${decoded.toolCallId}
        AND json_extract(payload_json, '$.approval_data._tag') = 'ConnectionRequired'
      LIMIT 1
    `.pipe(
        Effect.mapError((cause) =>
          toolError(
            "pending_connections",
            "storage",
            "Could not read pending connection",
            decoded,
            cause
          )
        )
      )
      const row = rows[0]
      if (row === undefined) return null
      yield* validatePendingLineage(sql, [row], "pending_connections")
      return yield* decodePendingConnection(row, "pending_connections")
    }
  )

  return {
    history: {
      agentAssignment,
      historyResultMetadata,
      ledgerToolCall,
      pendingApprovals,
      pendingDescendantApprovals,
      pendingConnections,
      pendingDescendantConnections
    },
    priorResults,
    pendingConnection,
    allPendingConnections
  }
}
