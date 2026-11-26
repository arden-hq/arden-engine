import { TOOL_APPROVAL_KIND } from "./tool-rows.js"
import { SESSION_TYPE } from "@arden-hq/protocol/sessions"
import {
  storedCard,
  approvalDiff,
  approvalPreview,
  askerOf,
  storedRulePlaces
} from "./run-approvals.js"
import { disposableForkSql } from "../schema/fork-disposition.js"
import type { RuntimeApprovalSnapshot } from "@arden-hq/protocol/chat"
import { Effect, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { JsonObjectSchema } from "../json.js"
import { grantFolderOf } from "../permissions/grant-folder.js"
import {
  PENDING_DECISION_OPERATION,
  ToolExecutionStoreError,
  type PendingDecisionOperation
} from "../tools/store.js"
import { decodeJson } from "./json.js"
import { pendingDecisionCards } from "./pending-decision-cards.js"
import { decisionLineageSql } from "../schema/decision-visibility.js"
import { type ApprovalRow, toolError, decodePendingConnection } from "./tool-rows.js"
import { sessionAncestors, sessionDescendants } from "./tree-walk.js"
import { type PendingConnectionDecision } from "../../connections/recovery.js"

const DescendantSessionIdsSchema = Schema.Array(Schema.NonEmptyString)

export const decodePendingApprovals = (
  rows: ReadonlyArray<ApprovalRow>
): Effect.Effect<Array<RuntimeApprovalSnapshot>, ToolExecutionStoreError> =>
  Effect.forEach(
    rows,
    Effect.fn("SqliteToolExecutionStore.decodePendingApproval")(function* (row) {
      if (row.kind !== TOOL_APPROVAL_KIND.approval && row.kind !== TOOL_APPROVAL_KIND.outcome) {
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
      const optionalBoolean = (key: string): boolean | undefined =>
        Predicate.isBoolean(payload[key]) ? payload[key] : undefined
      const rulePlaces = storedRulePlaces(payload)
      return {
        tool_id: row.tool_call_id,
        tool_name: row.tool_name,
        source: row.source ?? "run",
        preview: approvalPreview(row.preview),
        diff: approvalDiff(row.diff),
        status: "pending",
        requested_at: row.requested_at,
        run_id: row.run_id,
        session_id: row.session_id,
        action: row.action,
        rule_places: rulePlaces,
        can_attach_folder_to_space: optionalBoolean("can_attach_folder_to_space") === true,
        grant_folder: grantFolderOf(row.tool_name, payload.approval_data),
        card: storedCard(payload.presentation),
        asker: askerOf(row.work_json ?? null)
      } satisfies RuntimeApprovalSnapshot
    })
  )

export const descendantSessionIds = Effect.fn("SqliteToolExecutionStore.descendantSessionIds")(
  function* (
    db: SqlClient.SqlClient,
    sessionId: string
  ): Effect.fn.Return<ReadonlyArray<string>, ToolExecutionStoreError> {
    const rows = yield* db<{ readonly session_id: string }>`
    WITH RECURSIVE ${sessionDescendants(db, {
      name: "descendants",
      from: db`SELECT session_id FROM sessions WHERE session_id = ${sessionId}`,
      where: db`child.session_type = 'agent'`
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

export const indexedVisibilityReady = Effect.fn("SqliteToolExecutionStore.indexedVisibilityReady")(
  function* (
    db: SqlClient.SqlClient,
    viewerSessionId: string,
    operation: PendingDecisionOperation
  ): Effect.fn.Return<boolean, ToolExecutionStoreError> {
    const rows = yield* db<{ readonly finished_at: string | null }>`
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
    const unresolved = yield* db`
      WITH RECURSIVE sources(session_id, source_kind, decision_kind) AS (
        SELECT source.session_id, 'run', source.kind
        FROM pending_decision_visibility_unresolved AS unresolved
        JOIN tool_approvals AS source ON source.run_id = unresolved.run_id
          AND source.tool_call_id = unresolved.tool_call_id
        WHERE unresolved.source_kind = 'run' AND source.status = 'pending'
          AND CASE WHEN json_valid(source.payload_json) THEN ${
            operation === PENDING_DECISION_OPERATION.connections
              ? db`json_extract(source.payload_json, '$.approval_data._tag') = 'ConnectionRequired'`
              : db`COALESCE(json_extract(source.payload_json, '$.approval_data._tag'), '') != 'ConnectionRequired'`
          } ELSE 1 END
        UNION ALL
        SELECT source.session_id, 'deferred', 'tool_approval'
        FROM pending_decision_visibility_unresolved AS unresolved
        JOIN deferred_tool_calls AS source ON source.run_id = unresolved.run_id
          AND source.tool_call_id = unresolved.tool_call_id
        WHERE unresolved.source_kind = 'deferred' AND source.status = 'pending'
          AND CASE WHEN json_valid(source.payload_json) THEN ${
            operation === PENDING_DECISION_OPERATION.connections
              ? db`json_extract(source.payload_json, '$.approval_data._tag') = 'ConnectionRequired'`
              : db`COALESCE(json_extract(source.payload_json, '$.approval_data._tag'), '') != 'ConnectionRequired'`
          } ELSE 1 END
      ), ${sessionAncestors(db, {
        name: "lineage",
        from: db`SELECT session_id FROM sources JOIN sessions USING(session_id)`,
        where: db`child.session_type = 'agent'`,
        root: true
      })}
      SELECT 1 FROM lineage WHERE session_id = ${viewerSessionId}
      UNION ALL
      SELECT 1 FROM lineage
      JOIN sessions AS session ON session.session_id = lineage.session_id
      JOIN sources AS source ON source.session_id = lineage.root_session_id
      JOIN session_fork_requests AS fork ON fork.child_session_id = lineage.session_id
        AND fork.state = 'ready' AND json_valid(fork.request_json)
        AND ${db.literal(disposableForkSql("fork"))}
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

export const legacySideOutcomeRows = Effect.fn("SqliteToolExecutionStore.legacySideOutcomeRows")(
  function* (
    db: SqlClient.SqlClient,
    viewerSessionId: string,
    connection: boolean
  ): Effect.fn.Return<ReadonlyArray<ApprovalRow>, ToolExecutionStoreError> {
    const rows = yield* db<ApprovalRow>`
      WITH RECURSIVE ${sessionDescendants(db, {
        name: "side_tree",
        from: db`SELECT fork.child_session_id AS session_id FROM session_fork_requests AS fork
          CROSS JOIN sessions AS side ON side.session_id = fork.child_session_id
            AND side.session_type = 'chat'
          WHERE fork.source_session_id = ${viewerSessionId} AND fork.state = 'ready'
            AND json_valid(fork.request_json)
            AND ${db.literal(disposableForkSql("fork"))}`,
        where: db`child.session_type = 'agent'`
      })}
      SELECT run_id, session_id, tool_call_id, tool_name, action, scope,
        preview, diff, status, requested_at, resolved_at, expires_at,
        result_feedback, kind, payload_json, resolution_json, source
      FROM (${pendingDecisionCards(db)})
      WHERE session_id IN (SELECT session_id FROM side_tree)
        AND source = 'run' AND kind = 'tool_outcome'
        AND ${
          connection
            ? db`json_extract(payload_json, '$.approval_data._tag') = 'ConnectionRequired'`
            : db`COALESCE(json_extract(payload_json, '$.approval_data._tag'), '') != 'ConnectionRequired'`
        }
      ORDER BY requested_at, run_id, tool_call_id
    `.pipe(
      Effect.mapError((cause) =>
        toolError(
          connection
            ? PENDING_DECISION_OPERATION.connections
            : PENDING_DECISION_OPERATION.approvals,
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

export const orderedDecisionRows = (rows: ReadonlyArray<ApprovalRow>): ReadonlyArray<ApprovalRow> =>
  [...rows].sort(
    (a, b) =>
      a.requested_at.localeCompare(b.requested_at) ||
      a.run_id.localeCompare(b.run_id) ||
      a.tool_call_id.localeCompare(b.tool_call_id) ||
      (a.source ?? "run").localeCompare(b.source ?? "run")
  )

export const validDescendantSessionIds = (
  ids: ReadonlyArray<string>,
  operation: PendingDecisionOperation
): Effect.Effect<ReadonlyArray<string>, ToolExecutionStoreError> =>
  Schema.decodeUnknownEffect(DescendantSessionIdsSchema)(ids).pipe(
    Effect.mapError((cause) =>
      toolError(operation, "invalid", "Invalid session id", undefined, cause)
    )
  )

export const validatePendingLineage = Effect.fn("SqliteToolExecutionStore.validatePendingLineage")(
  function* (
    db: SqlClient.SqlClient,
    rows: ReadonlyArray<ApprovalRow>,
    operation: PendingDecisionOperation
  ): Effect.fn.Return<void, ToolExecutionStoreError> {
    for (const sourceSessionId of new Set(rows.map((row) => row.session_id))) {
      const lineage = yield* db
        .unsafe<{
          readonly session_type: string
          readonly edge_valid: number
        }>(decisionLineageSql("?"), [sourceSessionId])
        .pipe(
          Effect.mapError((cause) =>
            toolError(operation, "storage", "Could not check decision ownership", undefined, cause)
          )
        )
      if (
        lineage.length === 0 ||
        lineage.some((row) => row.edge_valid !== 1) ||
        !lineage.some((row) => row.session_type !== SESSION_TYPE.agent)
      )
        return yield* toolError(operation, "corrupt", "Stored decision ownership is invalid")
    }
  }
)

export const decodePendingConnections = (
  rows: ReadonlyArray<ApprovalRow>
): Effect.Effect<Array<PendingConnectionDecision>, ToolExecutionStoreError> =>
  Effect.forEach(
    rows,
    Effect.fn("SqliteToolExecutionStore.decodePendingConnectionRow")(function* (row) {
      const decision = yield* decodePendingConnection(row, PENDING_DECISION_OPERATION.connections)
      if (decision === null) {
        return yield* toolError(
          PENDING_DECISION_OPERATION.connections,
          "corrupt",
          "Stored pending connection is missing recovery data",
          { runId: row.run_id, toolCallId: row.tool_call_id }
        )
      }
      return decision
    })
  )
