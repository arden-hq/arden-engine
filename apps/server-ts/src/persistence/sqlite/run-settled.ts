import { isTerminalRunStatus } from "@arden-hq/protocol/runs"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { feedsActivityTriggers } from "../automations/triggers.js"
import { SessionLifecycleEventError, type SessionLifecycleEvents } from "../sessions/events.js"
import { readRunCause } from "./run-cause.js"

export const appendRunSettledInTransaction = Effect.fn("SessionLifecycleEvents.appendRunSettled")(
  function* (
    sql: SqlClient.SqlClient,
    sessionEvents: SessionLifecycleEvents["Service"],
    runId: string
  ) {
    const rows = yield* sql<{
      readonly session_id: string
      readonly status: string
      readonly assistant_message_id: string
      readonly session_type: string | null
      readonly origin_automation_id: string | null
    }>`
      SELECT run.session_id, run.status, run.assistant_message_id,
        session.session_type, session.origin_automation_id
      FROM chat_runs AS run
      JOIN sessions AS session ON session.session_id = run.session_id
      WHERE run.run_id = ${runId}
    `.pipe(
      Effect.mapError(
        (cause) =>
          new SessionLifecycleEventError({
            operation: "append",
            message: "Could not read the settled run",
            cause
          })
      )
    )
    const row = rows[0]
    if (row === undefined || !isTerminalRunStatus(row.status)) return
    yield* sessionEvents.appendEventInTransaction({
      type: "run_settled",
      run_id: runId,
      session_id: row.session_id,
      status: row.status,
      final_message_id: row.assistant_message_id,
      personal: feedsActivityTriggers({
        sessionType: row.session_type ?? "chat",
        originAutomationId: row.origin_automation_id
      }),
      ...(yield* readRunCause(sql, runId))
    })
  }
)
