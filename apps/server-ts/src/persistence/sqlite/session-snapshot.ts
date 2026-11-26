import { SessionListItemSchema } from "@arden-hq/protocol/effect/sessions"
import type { RuntimeRunStatus } from "@arden-hq/protocol"
import { journalHeadSequenceSql } from "@arden-hq/journal/effect"
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { lifecycleError } from "./lifecycle-archived.js"
import { latestSessionRunQuery } from "./session-latest-run.js"
import { sessionPresentations } from "./session-presentation.js"
import { pendingDecisionCards } from "./pending-decision-cards.js"
import { decodeJsonWith } from "./json.js"
import { freshTriage, StoredTriageSchema } from "../sessions/triage.js"
import { StoredForkSchema } from "../sessions/fork.js"
import { sessionOriginColumns, sessionParentStep, type ParentStepRow } from "./session-origin.js"
import {
  originAutomation,
  sessionActivity,
  sessionChatModel,
  sessionFork,
  sessionName,
  sessionOrigin,
  sessionParent,
  sessionRun,
  sessionSpace,
  sessionTriage,
  threadSource
} from "../../sessions/session-states.js"

interface SessionListRow extends ParentStepRow {
  readonly session_id: string
  readonly public_ref: string
  readonly started_at: string
  readonly last_activity: string
  readonly last_accessed_at: string | null
  readonly name: string | null
  readonly message_count: number
  readonly space_id: string | null
  readonly chat_model: string | null
  readonly session_type: string | null
  readonly origin_automation_id: string | null
  readonly parent_session_id: string | null
  readonly parent_run_id: string | null
  readonly parent_message_id: string | null
  readonly has_unread: number
  readonly latest_event_seq: number
  readonly checkpoint_seq: number
  readonly run_id: string | null
  readonly run_turn_id: string | null
  readonly run_status: RuntimeRunStatus | null
  readonly run_error_code: string | null
  readonly run_stop_reason: string | null
  readonly pending_approvals_count: number
  readonly pending_connections_count: number
  readonly triage_json: string | null
  readonly fork_json: string | null
  readonly thread_source_id: string | null
  readonly thread_source_ref: string | null
  readonly origin: "capture" | "onboarding" | null
}

export const loadSessionSnapshot = Effect.fn("SessionLifecycleEvents.loadSessionSnapshot")(
  function* (sql: SqlClient.SqlClient, sessionId: string) {
    const rows = yield* sql<SessionListRow>`
    SELECT s.session_id, s.public_ref, s.started_at, s.last_activity,
           s.last_accessed_at, s.name,
           s.visible_message_count AS message_count, s.space_id, s.chat_model,
           s.session_type, s.origin_automation_id, s.parent_session_id,
           s.parent_run_id, s.parent_tool_call_id, s.parent_message_id,
           s.has_unread,
           json_extract(s.metadata, '$.triage') AS triage_json,
           json_extract(s.metadata, '$.fork') AS fork_json,
           json_extract(s.metadata, '$.thread.source_session_id') AS thread_source_id,
           (SELECT source.public_ref FROM sessions AS source
             WHERE source.session_id = json_extract(s.metadata, '$.thread.source_session_id')
           ) AS thread_source_ref,
           ${sql.literal(sessionOriginColumns)},
           COALESCE(${journalHeadSequenceSql(sql, sql.literal("s.session_id"))}, 0) AS latest_event_seq,
           COALESCE((
             SELECT checkpoint_seq FROM session_event_checkpoints
             WHERE session_id = s.session_id
           ), 0) AS checkpoint_seq,
           latest_run.run_id AS run_id,
           json_extract(latest_run.metadata_json, '$.turn_id') AS run_turn_id,
           latest_run.status AS run_status,
           latest_run.error_code AS run_error_code,
           latest_run.stop_reason AS run_stop_reason,
           (
             SELECT COUNT(*) FROM (${pendingDecisionCards(sql)}) AS pending_approval
             WHERE pending_approval.session_id = s.session_id
               AND COALESCE(
                 json_extract(pending_approval.payload_json, '$.approval_data._tag'),
                 ''
               ) != 'ConnectionRequired'
           ) AS pending_approvals_count,
           (
             SELECT COUNT(*) FROM (${pendingDecisionCards(sql)}) AS pending_connection
             WHERE pending_connection.session_id = s.session_id
               AND json_extract(
                 pending_connection.payload_json,
                 '$.approval_data._tag'
               ) = 'ConnectionRequired'
           ) AS pending_connections_count
    FROM sessions AS s
    LEFT JOIN chat_runs AS latest_run
      ON latest_run.run_id = (${sql.literal(latestSessionRunQuery)})
    WHERE s.session_id = ${sessionId} AND s.archived_at IS NULL
    LIMIT 1
  `.pipe(
      Effect.mapError((cause) =>
        lifecycleError("append", "Could not read the Session lifecycle snapshot", cause)
      )
    )
    const row = rows[0]
    if (row === undefined) {
      return yield* lifecycleError("append", "Session lifecycle snapshot does not exist")
    }
    if (row.run_id !== null && (row.run_turn_id === null || row.run_turn_id.length === 0)) {
      return yield* lifecycleError("append", `Stored Chat run ${row.run_id} has no durable turn id`)
    }
    const presentations = yield* sessionPresentations(sql, [sessionId]).pipe(
      Effect.mapError((cause) => lifecycleError("append", "Could not classify Session", cause))
    )
    const triage =
      row.triage_json === null
        ? undefined
        : yield* decodeJsonWith(StoredTriageSchema, row.triage_json, (cause) =>
            lifecycleError("append", "Stored triage decision is corrupt", cause)
          )
    const fork =
      row.fork_json === null
        ? null
        : yield* decodeJsonWith(StoredForkSchema, row.fork_json, (cause) =>
            lifecycleError("append", "Stored fork origin is corrupt", cause)
          )
    return yield* Schema.decodeUnknownEffect(SessionListItemSchema)({
      presentation: presentations.get(sessionId),
      session_id: row.session_id,
      public_ref: row.public_ref,
      started_at: row.started_at,
      last_activity: row.last_activity,
      has_unread: row.has_unread !== 0,
      name: sessionName(row.name),
      message_count: row.message_count,
      space: sessionSpace(row.space_id),
      chat_model: sessionChatModel(row.chat_model),
      session_type: row.session_type ?? "chat",
      origin_automation: originAutomation(row.origin_automation_id),
      parent: sessionParent({
        sessionId: row.parent_session_id,
        runId: row.parent_run_id,
        toolCallId: row.parent_tool_call_id,
        messageId: row.parent_message_id,
        step: sessionParentStep(row)
      }),
      run: sessionRun({
        latest:
          row.run_id === null || row.run_status === null
            ? undefined
            : { runId: row.run_id, status: row.run_status },
        turnId: row.run_turn_id
      }),
      checkpoint_seq: row.checkpoint_seq,
      latest_event_seq: row.latest_event_seq,
      pending_approvals_count: row.pending_approvals_count,
      pending_connections_count: row.pending_connections_count,
      triage: sessionTriage(
        freshTriage(triage, { messageCount: row.message_count, lastActivity: row.last_activity })
      ),
      fork: sessionFork(fork),
      thread_source: threadSource(row.thread_source_id, row.thread_source_ref),
      origin: sessionOrigin(row.origin),
      current_activity: sessionActivity(undefined)
    }).pipe(
      Effect.mapError((cause) =>
        lifecycleError("append", "Stored Session lifecycle snapshot is corrupt", cause)
      )
    )
  }
)
