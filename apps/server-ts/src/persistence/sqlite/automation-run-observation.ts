import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { ChatRunErrorCodeSchema } from "@arden-hq/protocol/effect/chat"
import { RUN_STATUS } from "@arden-hq/protocol/chat"
import { isActiveRunStatus } from "@arden-hq/protocol/runs"
import { quietRunOutcome } from "./run-outcomes.js"
import {
  isAutomationBlockedKind,
  OBSERVED_RUN,
  type AutomationBlockedReport,
  type ObservedAutomationChatRun,
  type ObservedAutomationOccurrence
} from "../automations/queue.js"
import type { AutomationStoreError } from "../automations/store.js"
import { storeError } from "./automation-rows.js"
import { activeRunStatusList } from "./status-sets.js"
import { sessionDescendants } from "./tree-walk.js"
import { RUN_AUTHORITY_STATE, runAuthorityState, type RunAuthorityState } from "./run-context.js"
import { parkedOnQuota, quotaPauseUntil } from "./run-wait.js"

interface ObservedChatRunRow {
  readonly status: string
  readonly session_id: string
  readonly paused_until: string | null
  readonly stop_reason: string | null
  readonly error_code: string | null
  readonly error_message: string | null
  readonly result: string | null
  readonly blocked_kind: string | null
  readonly blocked_reason: string | null
  readonly no_change: string | null
  readonly wrote: number
}

const blockedReport = (row: ObservedChatRunRow): AutomationBlockedReport | null => {
  const kind = row.blocked_kind
  if (!isAutomationBlockedKind(kind)) return null
  const reason = row.blocked_reason?.trim()
  return { kind, reason: reason === undefined || reason === "" ? "No reason given." : reason }
}

export interface AutomationRunObservation {
  readonly observeChatRun: (
    chatRunId: string
  ) => Effect.Effect<ObservedAutomationChatRun | null, AutomationStoreError>
  readonly observeOccurrence: (
    attemptId: number
  ) => Effect.Effect<ObservedAutomationOccurrence | null, AutomationStoreError>
}

export const makeAutomationRunObservation = (
  sql: SqlClient.SqlClient
): AutomationRunObservation => {
  const observeChatRun = Effect.fn("SqliteAutomationStore.observeChatRun")(function* (
    chatRunId: string
  ) {
    const rows = yield* sql<ObservedChatRunRow>`
      SELECT run.status, run.session_id, run.stop_reason, run.error_code, run.error_message,
             ${quotaPauseUntil(sql, sql`run.metadata_json`)} AS paused_until,
             COALESCE(json_extract(run.metadata_json, '$.terminal_result.text'), message.search_text) AS result,
             json_extract(sidecar.evidence_json, '$.automation_outcome.kind') AS blocked_kind,
             json_extract(sidecar.evidence_json, '$.automation_outcome.reason') AS blocked_reason,
             CASE WHEN ${quietRunOutcome(sql, "run")}
               THEN json_extract(run.metadata_json, '$.no_change_reason') END AS no_change,
             EXISTS (
               SELECT 1 FROM tool_calls
               WHERE tool_calls.run_id = run.run_id
                 AND tool_calls.changes_state = 1
                 AND tool_calls.status = 'completed'
             ) AS wrote
      FROM chat_runs AS run
      LEFT JOIN session_messages AS message
        ON message.session_id = run.session_id
       AND message.message_id = run.assistant_message_id
      LEFT JOIN run_sidecars AS sidecar ON sidecar.run_id = run.run_id
      WHERE run.run_id = ${chatRunId}
      LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        storeError(
          "observe_chat_run",
          "storage",
          "Could not observe Automation Chat run",
          undefined,
          cause
        )
      )
    )
    const row = rows[0]
    if (row === undefined) return null
    if (isActiveRunStatus(row.status)) {
      return row.status === RUN_STATUS.pending && row.paused_until !== null
        ? ({
            status: OBSERVED_RUN.paused,
            sessionId: row.session_id,
            until: row.paused_until
          } satisfies ObservedAutomationChatRun)
        : ({ status: OBSERVED_RUN.running } satisfies ObservedAutomationChatRun)
    }
    const blocked = blockedReport(row)
    const wrote = row.wrote === 1
    if (row.status === RUN_STATUS.completed) {
      return {
        status: OBSERVED_RUN.completed,
        result: row.result,
        error: null,
        errorCode: null,
        blocked,
        noChange: row.no_change,
        wrote
      } satisfies ObservedAutomationChatRun
    }
    return {
      status: row.status === RUN_STATUS.cancelled ? OBSERVED_RUN.cancelled : OBSERVED_RUN.failed,
      result: row.result,
      error: row.error_message ?? row.stop_reason ?? row.error_code ?? `Chat run ${row.status}`,
      errorCode: Schema.is(ChatRunErrorCodeSchema)(row.error_code) ? row.error_code : null,
      blocked,
      noChange: row.no_change,
      wrote
    } satisfies ObservedAutomationChatRun
  })

  const observeOccurrence = Effect.fn("SqliteAutomationStore.observeOccurrence")(function* (
    attemptId: number
  ) {
    const rows = yield* sql<{
      readonly final_run_id: string | null
      readonly session_id: string | null
      readonly working: number
      readonly arriving: number
      readonly authority: RunAuthorityState | null
      readonly paused_until: string | null
      readonly paused_session_id: string | null
    }>`
      WITH RECURSIVE attempt AS (
        SELECT origin, chat_session_id FROM automation_runs WHERE id = ${attemptId}
      ),
      own AS (
        SELECT run.run_id, run.session_id, run.status, run.started_at, run.metadata_json
        FROM chat_runs AS run JOIN attempt ON run.session_id = attempt.chat_session_id
        WHERE json_extract(run.metadata_json, '$.run_context.origin') = json(attempt.origin)
      ),
      ${sessionDescendants(sql, {
        name: "tree",
        from: sql`SELECT child.session_id FROM sessions AS child JOIN attempt
          ON child.parent_session_id = attempt.chat_session_id
          WHERE child.session_type = 'agent'`,
        where: sql`child.session_type = 'agent'`,
        depth: { max: 63 }
      })},
      -- Drive from descendant Sessions so each Run lookup uses the session index,
      -- rather than scanning every historical Run on each poll.
      members AS (
        SELECT run_id, session_id, status, metadata_json FROM own
        UNION ALL
        SELECT run.run_id, run.session_id, run.status, run.metadata_json
        FROM tree CROSS JOIN chat_runs AS run ON run.session_id = tree.session_id
        WHERE json_extract(run.authority_json, '$.delegation.chain[0]') IN (SELECT run_id FROM own)
      ),
      paused AS (
        SELECT session_id, ${quotaPauseUntil(sql, sql`metadata_json`)} AS until FROM members
        WHERE ${parkedOnQuota(sql, sql`status`, sql`metadata_json`)}
      )
      SELECT
        (SELECT run_id FROM own ORDER BY started_at DESC, run_id DESC LIMIT 1) AS final_run_id,
        (SELECT chat_session_id FROM attempt) AS session_id,
        (SELECT ${runAuthorityState(sql, sql`metadata_json`, sql`run_id`, sql`session_id`)} FROM own
          ORDER BY started_at DESC, run_id DESC LIMIT 1) AS authority,
        (SELECT COUNT(*) FROM members WHERE status IN ${activeRunStatusList}
          AND NOT ${parkedOnQuota(sql, sql`status`, sql`metadata_json`)}) AS working,
        EXISTS (SELECT 1 FROM automation_deliveries AS delivery
          WHERE delivery.status = 'pending'
            AND json_extract(delivery.payload, '$.kind') IN ('result', 'answer')
            AND json_extract(delivery.payload, '$.runIds[0]') IN (SELECT run_id FROM members)
            AND json_extract(delivery.payload, '$.sessionId') IN (SELECT session_id FROM members)) AS arriving,
        (SELECT MAX(until) FROM paused) AS paused_until,
        (SELECT session_id FROM paused ORDER BY until DESC LIMIT 1) AS paused_session_id
    `.pipe(
      Effect.mapError((cause) =>
        storeError(
          "observe_chat_run",
          "storage",
          "Could not observe the Automation occurrence",
          undefined,
          cause
        )
      )
    )
    const row = rows[0]
    if (row === undefined || row.final_run_id === null || row.session_id === null) return null
    if (row.working > 0 || (row.arriving === 1 && row.authority === RUN_AUTHORITY_STATE.active)) {
      return { status: OBSERVED_RUN.running } satisfies ObservedAutomationOccurrence
    }
    if (row.paused_until !== null && row.paused_session_id !== null) {
      return {
        status: OBSERVED_RUN.paused,
        sessionId: row.paused_session_id,
        until: row.paused_until
      } satisfies ObservedAutomationOccurrence
    }
    const final = yield* observeChatRun(row.final_run_id)
    if (
      final === null ||
      final.status === OBSERVED_RUN.running ||
      final.status === OBSERVED_RUN.paused
    )
      return final
    return {
      ...final,
      runId: row.final_run_id,
      sessionId: row.session_id
    } satisfies ObservedAutomationOccurrence
  })

  return { observeChatRun, observeOccurrence }
}
