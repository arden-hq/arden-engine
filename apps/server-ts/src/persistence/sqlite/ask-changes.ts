import { DateTime, Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import { appendQuestionChange } from "./question-events.js"
import { runColumns, runDestinationSessionId } from "./run-destination.js"
import { touch } from "./tells/capture.js"
import { causingAutomation, readRunCause } from "./run-cause.js"
import { liftChat } from "./session-unread.js"

type AskChange =
  | {
      readonly kind: "approval_opened"
      readonly runId: string
      readonly sessionId: string
      readonly toolCallId: string
      readonly toolName: string
    }
  | { readonly kind: "question_changed"; readonly questionId: string }

export const journalAskChange = Effect.fn("AskChanges.journal")(function* (
  sql: SqlClient.SqlClient,
  sessionEvents: Pick<
    SessionLifecycleEvents["Service"],
    "appendEventInTransaction" | "appendInTransaction"
  >,
  change: AskChange
) {
  switch (change.kind) {
    case "approval_opened": {
      yield* markAskDestination(sql, sessionEvents, change.runId)
      const cause = yield* readRunCause(sql, change.runId)
      yield* sessionEvents.appendEventInTransaction({
        type: "approval_waiting",
        run_id: change.runId,
        session_id: change.sessionId,
        tool_call_id: change.toolCallId,
        tool_name: change.toolName,
        ...cause
      })
      return true
    }
    case "question_changed": {
      const open = yield* sql<{ readonly run_id: string }>`SELECT run_id FROM run_questions
        WHERE question_id = ${change.questionId} AND resolution IS NULL AND closed_at IS NULL`
      if (open[0] !== undefined) yield* markAskDestination(sql, sessionEvents, open[0].run_id)
      return yield* appendQuestionChange({ sql, sessionEvents, questionId: change.questionId })
    }
  }
})

const refreshAskDestination = Effect.fn("AskChanges.refreshDestination")(function* (
  sql: SqlClient.SqlClient,
  sessionEvents: Pick<SessionLifecycleEvents["Service"], "appendInTransaction">,
  runId: string
) {
  const rows = yield* sql<{ readonly session_id: string }>`SELECT destination.session_id
    FROM chat_runs AS run
    JOIN sessions AS destination ON destination.session_id = ${runDestinationSessionId(sql, runColumns(sql, "run"))}
    WHERE run.run_id = ${runId} AND destination.session_id <> run.session_id
      AND destination.session_type IN ('chat', 'channel')`
  if (rows[0] !== undefined)
    yield* sessionEvents.appendInTransaction("session_activity", rows[0].session_id)
})

const markAskDestination = Effect.fn("AskChanges.markDestination")(function* (
  sql: SqlClient.SqlClient,
  sessionEvents: Pick<
    SessionLifecycleEvents["Service"],
    "appendEventInTransaction" | "appendInTransaction"
  >,
  runId: string
) {
  const at = DateTime.formatIso(yield* DateTime.now)
  const rows = yield* sql<{ readonly session_id: string }>`SELECT destination.session_id
    FROM chat_runs AS run
    JOIN sessions AS destination ON destination.session_id = ${runDestinationSessionId(sql, runColumns(sql, "run"))}
    WHERE run.run_id = ${runId} AND destination.session_id <> run.session_id
      AND destination.session_type IN ('chat', 'channel')`
  const destination = rows[0]
  if (destination !== undefined)
    yield* liftChat(sql, sessionEvents, { sessionId: destination.session_id, at })
})

export const announceRunAskChange = Effect.fn("AskChanges.announceRunAsk")(function* (
  sql: SqlClient.SqlClient,
  sessionEvents: SessionLifecycleEvents["Service"],
  runId: string
) {
  yield* refreshAskDestination(sql, sessionEvents, runId)
  const owners = yield* sql<{ readonly task_id: string | null }>`
    SELECT ${causingAutomation(sql, "run")} AS task_id
    FROM chat_runs AS run WHERE run.run_id = ${runId}`
  for (const owner of owners)
    if (owner.task_id !== null) yield* touch(sql, "automation", owner.task_id)
})
