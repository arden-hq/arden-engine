import { Effect, Predicate, Schema } from "effect"
import type { PendingConnectionDecision } from "../../connections/recovery.js"
import { TOOL_STORE_FAILURE, ToolExecutionStoreError } from "../tools/store.js"
import { pendingDecisionCards, visiblePendingDecisionCards } from "./pending-decision-cards.js"
import type { PersistenceDeps } from "./deps.js"
import { type ApprovalRow, toolError } from "./tool-rows.js"
import {
  decodePendingConnections,
  descendantSessionIds,
  indexedVisibilityReady,
  legacySideOutcomeRows,
  orderedDecisionRows,
  validDescendantSessionIds,
  validatePendingLineage
} from "./tool-pending-support.js"

export interface PendingConnections {
  readonly pendingConnections: (
    sessionId: string
  ) => Effect.Effect<ReadonlyArray<PendingConnectionDecision>, ToolExecutionStoreError>
  readonly allPendingConnections: () => Effect.Effect<
    ReadonlyArray<PendingConnectionDecision>,
    ToolExecutionStoreError
  >
  readonly pendingDescendantConnections: (
    sessionId: string
  ) => Effect.Effect<ReadonlyArray<PendingConnectionDecision>, ToolExecutionStoreError>
}

export const makePendingConnections = ({
  sql,
  historySql
}: {
  readonly sql: PersistenceDeps["writer"]["sql"]
  readonly historySql: PersistenceDeps["reader"]
}): PendingConnections => {
  const pendingConnections = Effect.fn("SqliteToolExecutionStore.pendingConnections")(function* (
    sessionId: string
  ): Effect.fn.Return<ReadonlyArray<PendingConnectionDecision>, ToolExecutionStoreError> {
    const validSessionId = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(sessionId).pipe(
      Effect.mapError((cause) =>
        toolError("pending_connections", "invalid", "Invalid session id", undefined, cause)
      )
    )
    const rows = yield* historySql<ApprovalRow>`
      SELECT run_id, session_id, tool_call_id, tool_name, action, scope,
             preview, diff, status, requested_at, resolved_at, expires_at,
             result_feedback, kind, payload_json, resolution_json, source
      FROM (${pendingDecisionCards(historySql)})
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
    yield* validatePendingLineage(historySql, rows, "pending_connections")
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
          yield* validatePendingLineage(sql, [row], "pending_connections")
          return (yield* decodePendingConnections([row]))[0]
        }).pipe(
          Effect.catchTag("ToolExecutionStoreError", (error) => {
            if (error.reason !== TOOL_STORE_FAILURE.corrupt) return Effect.fail(error)
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
    if (yield* indexedVisibilityReady(historySql, sessionId, "pending_connections")) {
      const rows = yield* historySql<ApprovalRow>`
        SELECT run_id, session_id, tool_call_id, tool_name, action, scope,
               preview, diff, status, requested_at, resolved_at, expires_at,
               result_feedback, kind, payload_json, resolution_json, source
        FROM (${visiblePendingDecisionCards(historySql, sessionId)})
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
    const descendantIds = yield* descendantSessionIds(historySql, sessionId)
    const ids = yield* validDescendantSessionIds(descendantIds, "pending_connections")
    const sideRows = yield* legacySideOutcomeRows(historySql, sessionId, true)
    if (ids.length === 0) {
      yield* validatePendingLineage(historySql, sideRows, "pending_connections")
      return yield* decodePendingConnections(orderedDecisionRows(sideRows))
    }
    const rows = yield* historySql<ApprovalRow>`
      SELECT run_id, session_id, tool_call_id, tool_name, action, scope,
             preview, diff, status, requested_at, resolved_at, expires_at,
             result_feedback, kind, payload_json, resolution_json, source
      FROM (${pendingDecisionCards(historySql)})
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
    yield* validatePendingLineage(historySql, [...rows, ...sideRows], "pending_connections")
    return yield* decodePendingConnections(orderedDecisionRows([...rows, ...sideRows]))
  })
  return { pendingConnections, allPendingConnections, pendingDescendantConnections }
}
