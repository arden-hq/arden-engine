import { cutText, firstLine } from "@arden-hq/std/text"
import { captureMutationVersions } from "./mutation-links.js"
import type { MutationOperationIdentity } from "../tools/mutation-receipt.js"
import { outcomeSql } from "./automation-run-outcome.js"
import { countsAsRun } from "./automation-skip-record.js"
import { DateTime, Effect } from "effect"
import { isLastingRunError, providerSentence } from "@arden-hq/protocol/chat"
import { haltAutomation } from "./automation-halt.js"
import type { SqlClient } from "effect/unstable/sql"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import { recordAutomationEvent } from "./entity-events.js"
import { userAutomationSql } from "./authority-sql.js"
import { sha256Hex } from "@arden-hq/std/hash"

const FAILURES_BEFORE_PAUSE = 3

const lastingFailure = Effect.fn("AutomationAutoPause.lastingFailure")(function* (
  sql: SqlClient.SqlClient,
  attemptId: number
) {
  const rows = yield* sql<{ readonly error_code: string | null; readonly error: string | null }>`
    SELECT chat.error_code, COALESCE(chat.error_message, attempt.error) AS error
    FROM automation_runs AS attempt JOIN chat_runs AS chat ON chat.run_id = attempt.chat_run_id
    WHERE attempt.id = ${attemptId}`
  const row = rows[0]
  if (row === undefined || !isLastingRunError(row.error_code)) return undefined
  const error = (row.error ?? "").trim()
  const said = providerSentence(error) ?? (cutText(firstLine(error), 200) || "Its run failed.")
  const next =
    row.error_code === "model_unavailable"
      ? "Pick another model for it, then resume it."
      : "Resume it once that's fixed."
  return `${said} ${next}`
})

export const pauseAfterFailures = Effect.fn("AutomationAutoPause.pauseAfterFailures")(
  function* (options: {
    readonly sql: SqlClient.SqlClient
    readonly sessionEvents: SessionLifecycleEvents["Service"]
    readonly automationId: string
    readonly attemptId: number
  }) {
    const { sql, automationId } = options
    const lasting = yield* lastingFailure(sql, options.attemptId)
    const latest = yield* sql<{ readonly outcome: string }>`
      SELECT outcome FROM (SELECT id, ${outcomeSql(sql, sql`automation_runs`)} AS outcome
        FROM automation_runs
        WHERE task_id = ${automationId} AND ended_at IS NOT NULL
          AND ${countsAsRun(sql, sql`automation_runs`)}
          AND id > (SELECT COALESCE(MAX(json_extract(payload, '$.attemptId')), 0)
            FROM automation_deliveries
            WHERE task_id = ${automationId}
              AND json_extract(payload, '$.kind') = 'automation_paused'))
      WHERE outcome NOT IN ('cancelled', 'interrupted')
      ORDER BY id DESC LIMIT ${FAILURES_BEFORE_PAUSE}`
    const streak =
      latest.length === FAILURES_BEFORE_PAUSE && latest.every((run) => run.outcome === "failed")
    if (!streak && lasting === undefined) return false
    const live = yield* sql`SELECT task_id FROM scheduled_tasks
      WHERE task_id = ${automationId} AND ${userAutomationSql()} AND enabled = 1`
    if (live.length === 0) return false
    yield* haltAutomation({
      sql,
      sessionEvents: options.sessionEvents,
      automationId,
      halt: "pause"
    })
    const line =
      lasting === undefined
        ? `Paused after ${FAILURES_BEFORE_PAUSE} failed runs in a row. Resume it once the cause is fixed.`
        : `Paused: ${lasting}`
    yield* recordAutomationEvent(sql, {
      sessionEvents: options.sessionEvents,
      automationId,
      attemptId: options.attemptId,
      event: "paused",
      text: line
    })
    return true
  }
)

export const SPACE_ARCHIVED_PAUSE_LINE = "Paused: its chat's Space was archived"

interface SpacePausePayload {
  readonly kind: "automation_space_paused"
  readonly spaceId: string
  readonly resumedAt: string | null
}

export const pauseForArchivedSpace = Effect.fn("AutomationAutoPause.pauseForArchivedSpace")(
  function* (options: {
    readonly sql: SqlClient.SqlClient
    readonly sessionEvents: SessionLifecycleEvents["Service"]
    readonly spaceId: string
    readonly mutation?: MutationOperationIdentity | undefined
  }) {
    const { sql } = options
    const paused = yield* sql<{ readonly task_id: string }>`
      SELECT task_id FROM scheduled_tasks
      WHERE ${userAutomationSql()} AND enabled = 1
        AND thread_id IN (SELECT session_id FROM sessions WHERE space_id = ${options.spaceId})`
    const at = DateTime.formatIso(yield* DateTime.now)
    for (const { task_id: automationId } of paused) {
      const recordVersions = yield* captureMutationVersions(sql, {
        domain: "automation",
        id: automationId,
        identity: options.mutation
      })
      yield* haltAutomation({
        sql,
        sessionEvents: options.sessionEvents,
        automationId,
        halt: "stop"
      })
      const payload: SpacePausePayload = {
        kind: "automation_space_paused",
        spaceId: options.spaceId,
        resumedAt: null
      }
      yield* sql`INSERT INTO automation_deliveries (
          delivery_id, task_id, delivered_at, subject, body, payload, status, created_at, destinations
        ) VALUES (
          ${sha256Hex(`automation-space-paused:${automationId}:${at}`)}, ${automationId}, ${at},
          'paused', ${SPACE_ARCHIVED_PAUSE_LINE}, ${JSON.stringify(payload)}, 'delivered', ${at}, '[]'
        ) ON CONFLICT(delivery_id) DO NOTHING`
      yield* recordVersions
    }
    return paused.map((row) => row.task_id)
  }
)

export const endAutoPause = Effect.fn("AutomationAutoPause.end")(function* (
  sql: SqlClient.SqlClient,
  automationId: string
) {
  const at = DateTime.formatIso(yield* DateTime.now)
  yield* sql`UPDATE automation_deliveries SET payload = json_set(payload, '$.resumedAt', ${at})
    WHERE task_id = ${automationId}
      AND json_extract(payload, '$.kind') IN ('automation_paused', 'automation_space_paused')
      AND json_extract(payload, '$.resumedAt') IS NULL`
})
