import type { SqlClient } from "effect/unstable/sql"
import { runAsksVisiblePredicate } from "./question-events.js"
import { runColumns, runDestinationSessionId } from "./run-destination.js"

const asking = (sql: SqlClient.SqlClient) => sql`JOIN chat_runs AS card_run
  ON card_run.run_id = source.run_id AND ${runAsksVisiblePredicate(sql, runColumns(sql, "card_run"))}`

const destination = (sql: SqlClient.SqlClient) =>
  sql`COALESCE(${runDestinationSessionId(sql, runColumns(sql, "card_run"))}, source.session_id)
    AS destination_session_id,
    COALESCE(json_extract(card_run.metadata_json, '$.run_context.belongs_to'),
      json_extract(card_run.metadata_json, '$.run_context.origin')) AS work_json`

export const pendingDecisionCards = (sql: SqlClient.SqlClient) => sql`
  SELECT source.run_id, source.session_id, source.tool_call_id, source.tool_name,
         source.action, source.scope, source.preview, source.diff, source.requested_at,
         source.kind, source.payload_json, source.expires_at, source.result_feedback,
         source.resolution_json, source.status, source.resolved_at, 'run' AS source,
         ${destination(sql)}
  FROM tool_approvals AS source ${asking(sql)} WHERE source.status = 'pending'
  UNION ALL
  SELECT source.run_id, source.session_id, source.tool_call_id, source.tool_name,
         source.action, source.scope, source.preview, source.diff, source.requested_at,
         'tool_approval' AS kind, source.payload_json, NULL AS expires_at,
         NULL AS result_feedback, NULL AS resolution_json, source.status,
         source.resolved_at, 'deferred' AS source, ${destination(sql)}
  FROM deferred_tool_calls AS source ${asking(sql)} WHERE source.status = 'pending'
`

export const decisionRoutesSql = (sql: SqlClient.SqlClient) => sql`
  SELECT visibility.viewer_session_id, visibility.source_session_id, visibility.source_kind,
    visibility.run_id, visibility.tool_call_id, visibility.route_basis AS basis
  FROM pending_decision_visibility AS visibility
  UNION ALL
  SELECT card.destination_session_id, card.session_id, card.source, card.run_id,
    card.tool_call_id, 'destination_v1'
  FROM (${pendingDecisionCards(sql)}) AS card
  WHERE NOT EXISTS (SELECT 1 FROM pending_decision_visibility AS seen
    WHERE seen.source_kind = card.source AND seen.run_id = card.run_id
      AND seen.tool_call_id = card.tool_call_id
      AND seen.viewer_session_id = card.destination_session_id)
`

export const visiblePendingDecisionCards = (
  sql: SqlClient.SqlClient,
  viewerSessionId: string
) => sql`
  SELECT card.* FROM (${pendingDecisionCards(sql)}) AS card
  WHERE EXISTS (SELECT 1 FROM (${decisionRoutesSql(sql)}) AS route
    WHERE route.viewer_session_id = ${viewerSessionId} AND route.source_kind = card.source
      AND route.run_id = card.run_id AND route.tool_call_id = card.tool_call_id)
`
