import type { RunApprovalWork } from "@arden-hq/protocol/runs"
import { storedRulePlaces, workOf } from "./run-approvals.js"
import { refreshChangeEvidence, withNestedCallFacts, withScriptState } from "./change-evidence.js"
import { disposableForkSql } from "../schema/fork-disposition.js"
import { CODE_MODE_TOOL, SPAWN_AGENT_TOOL, nestedCallMarker } from "../tools/tool-roles.js"
import { sanitizeApprovalPresentation, type RuntimeApprovalSnapshot } from "@arden-hq/protocol/chat"
import { Effect, Predicate, Schema } from "effect"
import type { PendingConnectionDecision } from "../../connections/recovery.js"
import { JsonObjectSchema } from "../json.js"
import { grantFolderField } from "../permissions/grant-folder.js"
import {
  ToolHistoryQueries,
  type AgentAssignment,
  type LedgerToolCall,
  type LedgerToolCallInput,
  type ToolExecutionHistoryInput,
  type ToolExecutionResultMetadata
} from "../tools/history-queries.js"
import { ToolExecutionStore, ToolExecutionStoreError } from "../tools/store.js"
import { decodeJson } from "./json.js"
import { pendingDecisionCards, visiblePendingDecisionCards } from "./pending-decision-cards.js"
import type { PersistenceDeps } from "./deps.js"
import { decisionLineageSql } from "../schema/decision-visibility.js"
import {
  type ApprovalRow,
  PersistedToolResultSchema,
  toolError,
  decodePendingConnection
} from "./tool-rows.js"
import { resultToolStatusList } from "./status-sets.js"
import { sessionAncestors, sessionDescendants } from "./tree-walk.js"

interface ToolHistoryResultRow {
  readonly run_id: string
  readonly changes_state: number
  readonly tool_call_id: string
  readonly tool_name: string
  readonly result_json: string
  readonly started_at: string
  readonly ended_at: string | null
}

const ToolExecutionHistoryInputSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  toolCallIds: Schema.Array(Schema.NonEmptyString)
})

const DescendantSessionIdsSchema = Schema.Array(Schema.NonEmptyString)

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
  readonly history: ToolHistoryQueries["Service"]
} & Pick<
  ToolExecutionStore["Service"],
  "priorResults" | "pendingConnection" | "allPendingConnections"
> => {
  const sql = writer.sql
  const historySql = reader
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
      try {
        const parsed = JSON.parse(row.result_json) as { readonly data?: unknown }
        const data = parsed.data
        if (data !== null && typeof data === "object" && !Array.isArray(data)) {
          results.push({ runId: row.run_id, data: data as Readonly<Record<string, unknown>> })
        }
      } catch {
        continue
      }
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
          const result = yield* decodeJson(ToolHistoryMetadataSchema, row.result_json).pipe(
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
              const marker = nestedCallMarker(row.tool_name)
              if (marker === undefined) return Effect.succeed(refreshed)
              return withNestedCallFacts(
                historySql,
                { runId: row.run_id, toolCallId: row.tool_call_id },
                refreshed.data ?? {},
                marker
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
              ...(projected.data === undefined || projected.data === null
                ? {}
                : { data: projected.data }),
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
      readonly content: string | null
      readonly is_error: number | null
    }>`
      SELECT call.tool_name, call.arguments_json,
             json_extract(call.result_json, '$.content') AS content,
             json_extract(call.result_json, '$.is_error') AS is_error
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
    return {
      name: row.tool_name,
      arguments: row.arguments_json,
      result: Predicate.isString(row.content) ? row.content : undefined,
      isError: row.is_error === 1
    }
  })

  const decodePendingApprovals = (rows: ReadonlyArray<ApprovalRow>) =>
    Effect.forEach(
      rows,
      Effect.fn("SqliteToolExecutionStore.decodePendingApproval")(function* (row) {
        if (row.kind !== "tool_approval" && row.kind !== "tool_outcome") {
          return yield* toolError(
            "pending_approvals",
            "corrupt",
            "Stored tool approval kind is invalid"
          )
        }
        const payload = yield* decodeJson(JsonObjectSchema, row.payload_json).pipe(
          Effect.mapError((cause) =>
            toolError(
              "pending_approvals",
              "corrupt",
              "Stored tool approval payload is corrupt",
              { runId: row.run_id, toolCallId: row.tool_call_id },
              cause
            )
          )
        )
        const optionalString = (key: string): string | null =>
          Predicate.isString(payload[key]) ? payload[key] : null
        const optionalBoolean = (key: string): boolean | undefined =>
          Predicate.isBoolean(payload[key]) ? payload[key] : undefined
        const rulePlaces = storedRulePlaces(payload)
        return {
          tool_id: row.tool_call_id,
          tool_name: row.tool_name,
          source: row.source ?? "run",
          preview: row.preview,
          diff: row.diff,
          status: "pending",
          requested_at: row.requested_at,
          run_id: row.run_id,
          session_id: row.session_id,
          action: row.action,
          scope: row.scope,
          expires_at: row.expires_at,
          description: optionalString("description"),
          ...(rulePlaces.length === 0 ? {} : { rule_places: rulePlaces }),
          ...(optionalBoolean("can_attach_folder_to_space") === true
            ? { can_attach_folder_to_space: true }
            : {}),
          ...grantFolderField(row.tool_name, payload.approval_data),
          parent_session_id: optionalString("parent_session_id"),
          presentation: sanitizeApprovalPresentation(payload.presentation) ?? null,
          ...workField(row.work_json ?? null)
        } satisfies RuntimeApprovalSnapshot
      })
    )

  const pendingApprovals = Effect.fn("SqliteToolExecutionStore.pendingApprovals")(function* (
    sessionId: string
  ): Effect.fn.Return<ReadonlyArray<RuntimeApprovalSnapshot>, ToolExecutionStoreError> {
    const validSessionId = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(sessionId).pipe(
      Effect.mapError((cause) =>
        toolError("pending_approvals", "invalid", "Invalid session id", undefined, cause)
      )
    )
    const rows = yield* sql<ApprovalRow>`
      SELECT run_id, session_id, tool_call_id, tool_name, action, scope,
             preview, diff, status, requested_at, resolved_at, expires_at,
             result_feedback, kind, payload_json, resolution_json, source
      FROM (${pendingDecisionCards(sql)})
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
    yield* validatePendingLineage(rows, "pending_approvals")
    return yield* decodePendingApprovals(rows)
  })

  const descendantSessionIds = Effect.fn("SqliteToolExecutionStore.descendantSessionIds")(
    function* (
      sessionId: string
    ): Effect.fn.Return<ReadonlyArray<string>, ToolExecutionStoreError> {
      const rows = yield* sql<{ readonly session_id: string }>`
      WITH RECURSIVE ${sessionDescendants(sql, {
        name: "descendants",
        from: sql`SELECT session_id FROM sessions WHERE session_id = ${sessionId}`,
        where: sql`child.session_type = 'agent'`
      })}
      SELECT session_id FROM descendants WHERE session_id != ${sessionId}
    `.pipe(
        Effect.mapError((cause) =>
          toolError(
            "pending_approvals",
            "storage",
            "Could not list child agent sessions",
            undefined,
            cause
          )
        )
      )
      return rows.map((row) => row.session_id)
    }
  )

  const indexedVisibilityReady = Effect.fn("SqliteToolExecutionStore.indexedVisibilityReady")(
    function* (
      viewerSessionId: string,
      operation: "pending_approvals" | "pending_connections"
    ): Effect.fn.Return<boolean, ToolExecutionStoreError> {
      const rows = yield* sql<{ readonly finished_at: string | null }>`
        SELECT finished_at FROM data_backfills
        WHERE name = 'pending_decision_visibility_v2'`.pipe(
        Effect.mapError((cause) =>
          toolError(
            "pending_approvals",
            "storage",
            "Could not read decision index readiness",
            undefined,
            cause
          )
        )
      )
      if (rows[0]?.finished_at == null) return false
      const unresolved = yield* sql`
        WITH RECURSIVE sources(session_id, source_kind, decision_kind) AS (
          SELECT source.session_id, 'run', source.kind
          FROM pending_decision_visibility_unresolved AS unresolved
          JOIN tool_approvals AS source ON source.run_id = unresolved.run_id
            AND source.tool_call_id = unresolved.tool_call_id
          WHERE unresolved.source_kind = 'run' AND source.status = 'pending'
            AND CASE WHEN json_valid(source.payload_json) THEN ${
              operation === "pending_connections"
                ? sql`json_extract(source.payload_json, '$.approval_data._tag') = 'ConnectionRequired'`
                : sql`COALESCE(json_extract(source.payload_json, '$.approval_data._tag'), '') != 'ConnectionRequired'`
            } ELSE 1 END
          UNION ALL
          SELECT source.session_id, 'deferred', 'tool_approval'
          FROM pending_decision_visibility_unresolved AS unresolved
          JOIN deferred_tool_calls AS source ON source.run_id = unresolved.run_id
            AND source.tool_call_id = unresolved.tool_call_id
          WHERE unresolved.source_kind = 'deferred' AND source.status = 'pending'
            AND CASE WHEN json_valid(source.payload_json) THEN ${
              operation === "pending_connections"
                ? sql`json_extract(source.payload_json, '$.approval_data._tag') = 'ConnectionRequired'`
                : sql`COALESCE(json_extract(source.payload_json, '$.approval_data._tag'), '') != 'ConnectionRequired'`
            } ELSE 1 END
        ), ${sessionAncestors(sql, {
          name: "lineage",
          from: sql`SELECT session_id FROM sources JOIN sessions USING(session_id)`,
          where: sql`child.session_type = 'agent'`,
          root: true
        })}
        SELECT 1 FROM lineage WHERE session_id = ${viewerSessionId}
        UNION ALL
        SELECT 1 FROM lineage
        JOIN sessions AS session ON session.session_id = lineage.session_id
        JOIN sources AS source ON source.session_id = lineage.root_session_id
        JOIN session_fork_requests AS fork ON fork.child_session_id = lineage.session_id
          AND fork.state = 'ready' AND json_valid(fork.request_json)
          AND ${sql.literal(disposableForkSql("fork"))}
        JOIN sessions AS owner ON owner.session_id = fork.source_session_id
          AND owner.session_type = 'chat'
        WHERE session.session_type = 'chat' AND source.source_kind = 'run'
          AND source.decision_kind = 'tool_outcome'
          AND owner.session_id = ${viewerSessionId}
        LIMIT 1
      `.pipe(
        Effect.mapError((cause) =>
          toolError(
            operation,
            "storage",
            "Could not check unresolved decision ownership",
            undefined,
            cause
          )
        )
      )
      if (unresolved.length > 0)
        return yield* toolError(operation, "corrupt", "Stored decision ownership is invalid")
      return true
    }
  )

  const legacySideOutcomeRows = Effect.fn("SqliteToolExecutionStore.legacySideOutcomeRows")(
    function* (
      viewerSessionId: string,
      connection: boolean
    ): Effect.fn.Return<ReadonlyArray<ApprovalRow>, ToolExecutionStoreError> {
      const rows = yield* sql<ApprovalRow>`
        WITH RECURSIVE ${sessionDescendants(sql, {
          name: "side_tree",
          from: sql`SELECT fork.child_session_id AS session_id FROM session_fork_requests AS fork
            JOIN sessions AS side ON side.session_id = fork.child_session_id
              AND side.session_type = 'chat'
            WHERE fork.source_session_id = ${viewerSessionId} AND fork.state = 'ready'
              AND json_valid(fork.request_json)
              AND ${sql.literal(disposableForkSql("fork"))}`,
          where: sql`child.session_type = 'agent'`
        })}
        SELECT run_id, session_id, tool_call_id, tool_name, action, scope,
          preview, diff, status, requested_at, resolved_at, expires_at,
          result_feedback, kind, payload_json, resolution_json, source
        FROM (${pendingDecisionCards(sql)})
        WHERE session_id IN (SELECT session_id FROM side_tree)
          AND source = 'run' AND kind = 'tool_outcome'
          AND ${
            connection
              ? sql`json_extract(payload_json, '$.approval_data._tag') = 'ConnectionRequired'`
              : sql`COALESCE(json_extract(payload_json, '$.approval_data._tag'), '') != 'ConnectionRequired'`
          }
        ORDER BY requested_at, run_id, tool_call_id
      `.pipe(
        Effect.mapError((cause) =>
          toolError(
            connection ? "pending_connections" : "pending_approvals",
            "storage",
            "Could not load Side outcome recovery",
            undefined,
            cause
          )
        )
      )
      return rows
    }
  )

  const orderedDecisionRows = (rows: ReadonlyArray<ApprovalRow>): ReadonlyArray<ApprovalRow> =>
    [...rows].sort(
      (a, b) =>
        a.requested_at.localeCompare(b.requested_at) ||
        a.run_id.localeCompare(b.run_id) ||
        a.tool_call_id.localeCompare(b.tool_call_id) ||
        (a.source ?? "run").localeCompare(b.source ?? "run")
    )

  const validDescendantSessionIds = (
    ids: ReadonlyArray<string>,
    operation: "pending_approvals" | "pending_connections"
  ) =>
    Schema.decodeUnknownEffect(DescendantSessionIdsSchema)(ids).pipe(
      Effect.mapError((cause) =>
        toolError(operation, "invalid", "Invalid session id", undefined, cause)
      )
    )

  const validatePendingLineage = Effect.fn("SqliteToolExecutionStore.validatePendingLineage")(
    function* (
      rows: ReadonlyArray<ApprovalRow>,
      operation: "pending_approvals" | "pending_connections"
    ): Effect.fn.Return<void, ToolExecutionStoreError> {
      for (const sourceSessionId of new Set(rows.map((row) => row.session_id))) {
        const lineage = yield* sql
          .unsafe<{
            readonly session_type: string
            readonly edge_valid: number
          }>(decisionLineageSql("?"), [sourceSessionId])
          .pipe(
            Effect.mapError((cause) =>
              toolError(
                operation,
                "storage",
                "Could not check decision ownership",
                undefined,
                cause
              )
            )
          )
        if (
          lineage.length === 0 ||
          lineage.some((row) => row.edge_valid !== 1) ||
          !lineage.some((row) => row.session_type !== "agent")
        )
          return yield* toolError(operation, "corrupt", "Stored decision ownership is invalid")
      }
    }
  )

  const pendingDescendantApprovals = Effect.fn(
    "SqliteToolExecutionStore.pendingDescendantApprovals"
  )(function* (
    sessionId: string
  ): Effect.fn.Return<ReadonlyArray<RuntimeApprovalSnapshot>, ToolExecutionStoreError> {
    if (yield* indexedVisibilityReady(sessionId, "pending_approvals")) {
      const rows = yield* sql<ApprovalRow>`
        SELECT run_id, session_id, tool_call_id, tool_name, action, scope,
               preview, diff, status, requested_at, resolved_at, expires_at,
               result_feedback, kind, payload_json, resolution_json, source, work_json
        FROM (${visiblePendingDecisionCards(sql, sessionId)})
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
    const descendantIds = yield* descendantSessionIds(sessionId)
    const ids = yield* validDescendantSessionIds(descendantIds, "pending_approvals")
    const sideRows = yield* legacySideOutcomeRows(sessionId, false)
    if (ids.length === 0) {
      yield* validatePendingLineage(sideRows, "pending_approvals")
      return yield* decodePendingApprovals(orderedDecisionRows(sideRows))
    }
    const rows = yield* sql<ApprovalRow>`
      SELECT run_id, session_id, tool_call_id, tool_name, action, scope,
             preview, diff, status, requested_at, resolved_at, expires_at,
             result_feedback, kind, payload_json, resolution_json, source
      FROM (${pendingDecisionCards(sql)})
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
    yield* validatePendingLineage([...rows, ...sideRows], "pending_approvals")
    return yield* decodePendingApprovals(orderedDecisionRows([...rows, ...sideRows]))
  })

  const decodePendingConnections = (rows: ReadonlyArray<ApprovalRow>) =>
    Effect.forEach(
      rows,
      Effect.fn("SqliteToolExecutionStore.decodePendingConnectionRow")(function* (row) {
        const decision = yield* decodePendingConnection(row, "pending_connections")
        if (decision === null) {
          return yield* toolError(
            "pending_connections",
            "corrupt",
            "Stored pending connection is missing recovery data",
            { runId: row.run_id, toolCallId: row.tool_call_id }
          )
        }
        return decision
      })
    )

  const pendingConnections = Effect.fn("SqliteToolExecutionStore.pendingConnections")(function* (
    sessionId: string
  ): Effect.fn.Return<ReadonlyArray<PendingConnectionDecision>, ToolExecutionStoreError> {
    const validSessionId = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(sessionId).pipe(
      Effect.mapError((cause) =>
        toolError("pending_connections", "invalid", "Invalid session id", undefined, cause)
      )
    )
    const rows = yield* sql<ApprovalRow>`
      SELECT run_id, session_id, tool_call_id, tool_name, action, scope,
             preview, diff, status, requested_at, resolved_at, expires_at,
             result_feedback, kind, payload_json, resolution_json, source
      FROM (${pendingDecisionCards(sql)})
      WHERE session_id = ${validSessionId}
        AND json_extract(payload_json, '$.approval_data._tag') = 'ConnectionRequired'
      ORDER BY requested_at, run_id, tool_call_id
    `.pipe(
      Effect.mapError((cause) =>
        toolError(
          "pending_connections",
          "storage",
          "Could not list pending connections",
          undefined,
          cause
        )
      )
    )
    yield* validatePendingLineage(rows, "pending_connections")
    return yield* decodePendingConnections(rows)
  })

  const allPendingConnections = Effect.fn("SqliteToolExecutionStore.allPendingConnections")(
    function* (): Effect.fn.Return<
      ReadonlyArray<PendingConnectionDecision>,
      ToolExecutionStoreError
    > {
      const rows = yield* sql<ApprovalRow>`
      SELECT run_id, session_id, tool_call_id, tool_name, action, scope,
             preview, diff, status, requested_at, resolved_at, expires_at,
             result_feedback, kind, payload_json, resolution_json, source
      FROM (${pendingDecisionCards(sql)})
      WHERE json_extract(payload_json, '$.approval_data._tag') = 'ConnectionRequired'
      ORDER BY requested_at, run_id, tool_call_id
    `.pipe(
        Effect.mapError((cause) =>
          toolError(
            "pending_connections",
            "storage",
            "Could not list pending connections",
            undefined,
            cause
          )
        )
      )
      const decisions = yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          yield* validatePendingLineage([row], "pending_connections")
          return (yield* decodePendingConnections([row]))[0]
        }).pipe(
          Effect.catchTag("ToolExecutionStoreError", (error) => {
            if (error.reason !== "corrupt") return Effect.fail(error)
            return Effect.logWarning("Connection resume skipped a corrupt paused call", {
              runId: row.run_id,
              toolId: row.tool_call_id,
              sessionId: row.session_id,
              source: row.source,
              reason: error.reason,
              message: error.message
            }).pipe(Effect.as(undefined))
          })
        )
      )
      return decisions.filter(Predicate.isNotUndefined)
    }
  )

  const pendingDescendantConnections = Effect.fn(
    "SqliteToolExecutionStore.pendingDescendantConnections"
  )(function* (
    sessionId: string
  ): Effect.fn.Return<ReadonlyArray<PendingConnectionDecision>, ToolExecutionStoreError> {
    if (yield* indexedVisibilityReady(sessionId, "pending_connections")) {
      const rows = yield* sql<ApprovalRow>`
        SELECT run_id, session_id, tool_call_id, tool_name, action, scope,
               preview, diff, status, requested_at, resolved_at, expires_at,
               result_feedback, kind, payload_json, resolution_json, source
        FROM (${visiblePendingDecisionCards(sql, sessionId)})
        WHERE session_id != ${sessionId}
          AND json_extract(payload_json, '$.approval_data._tag') = 'ConnectionRequired'
        ORDER BY requested_at, run_id, tool_call_id, source
      `.pipe(
        Effect.mapError((cause) =>
          toolError(
            "pending_connections",
            "storage",
            "Could not list pending connections",
            undefined,
            cause
          )
        )
      )
      return yield* decodePendingConnections(rows)
    }
    const descendantIds = yield* descendantSessionIds(sessionId)
    const ids = yield* validDescendantSessionIds(descendantIds, "pending_connections")
    const sideRows = yield* legacySideOutcomeRows(sessionId, true)
    if (ids.length === 0) {
      yield* validatePendingLineage(sideRows, "pending_connections")
      return yield* decodePendingConnections(orderedDecisionRows(sideRows))
    }
    const rows = yield* sql<ApprovalRow>`
      SELECT run_id, session_id, tool_call_id, tool_name, action, scope,
             preview, diff, status, requested_at, resolved_at, expires_at,
             result_feedback, kind, payload_json, resolution_json, source
      FROM (${pendingDecisionCards(sql)})
      WHERE session_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
        AND json_extract(payload_json, '$.approval_data._tag') = 'ConnectionRequired'
      ORDER BY session_id, requested_at, run_id, tool_call_id
    `.pipe(
      Effect.mapError((cause) =>
        toolError(
          "pending_connections",
          "storage",
          "Could not list pending connections",
          undefined,
          cause
        )
      )
    )
    yield* validatePendingLineage([...rows, ...sideRows], "pending_connections")
    return yield* decodePendingConnections(orderedDecisionRows([...rows, ...sideRows]))
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
      yield* validatePendingLineage([row], "pending_connections")
      return yield* decodePendingConnection(row, "pending_connections")
    }
  )

  return {
    history: ToolHistoryQueries.of({
      agentAssignment,
      historyResultMetadata,
      ledgerToolCall,
      pendingApprovals,
      pendingDescendantApprovals,
      pendingConnections,
      pendingDescendantConnections
    }),
    priorResults,
    pendingConnection,
    allPendingConnections
  }
}

const workField = (json: string | null): { readonly work?: RunApprovalWork } => {
  const work = workOf(json)
  return work === null ? {} : { work }
}
