import { cutText, firstLine } from "@arden-hq/std/text"
import { captureMutationVersions } from "./mutation-links.js"
import type { MutationOperationIdentity } from "../tools/mutation-receipt.js"
import { DateTime, Effect } from "effect"
import { isLastingRunError, providerSentence } from "@arden-hq/protocol/chat"
import { haltAutomation } from "./automation-halt.js"
import type { SqlClient, SqlError } from "effect/unstable/sql"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import { recordAutomationEvent } from "./entity-events.js"
import { userAutomationSql } from "./authority-sql.js"
import { sha256Hex } from "@arden-hq/std/hash"

const FAILURES_BEFORE_GIVING_UP = 3

export type GiveUpCause =
  | { readonly kind: "streak" }
  | { readonly kind: "lasting"; readonly said: string; readonly next: string }

/**
 * What an item job does when it gives up, by the kind of failure; a user Automation pauses on
 * either. A lasting refusal (the provider, the model or the sign-in) says nothing about the item,
 * so the item is kept and tried again next run; only an item that fails run after run is skipped.
 */
export const ITEM_GIVE_UP = { lasting: "keep", streak: "skip" } as const satisfies Record<
  GiveUpCause["kind"],
  string
>

/**
 * The one rule for when an Automation gives up after its run `attemptId` failed: the failure is a
 * refusal that comes back the same until the owner changes something, or it is the
 * FAILURES_BEFORE_GIVING_UP-th failed run in a row on the same `item` since the streak last ended.
 * Counts the failure once per run; the caller ends the streak when it gives up.
 */
export const givesUp = Effect.fn("AutomationGiveUp.givesUp")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly automationId: string
    readonly attemptId: number
    readonly chatRunId: string | null
    readonly item: string | null
  }
): Effect.fn.Return<GiveUpCause | undefined, SqlError.SqlError> {
  const { automationId, attemptId, item } = input
  const lasting = yield* sql<{ readonly error_code: string | null; readonly error: string | null }>`
    SELECT chat.error_code, COALESCE(chat.error_message, attempt.error) AS error
    FROM chat_runs AS chat JOIN automation_runs AS attempt ON attempt.id = ${attemptId}
    WHERE chat.run_id = ${input.chatRunId}`
  const refused = lasting[0]
  if (refused !== undefined && isLastingRunError(refused.error_code)) {
    const error = (refused.error ?? "").trim()
    return {
      kind: "lasting",
      said: providerSentence(error) ?? (cutText(firstLine(error), 200) || "Its run failed."),
      next:
        refused.error_code === "model_unavailable"
          ? "Pick another model for it, then resume it."
          : "Resume it once that's fixed."
    }
  }
  const streak = yield* sql<{ readonly failed_runs: number }>`UPDATE scheduled_tasks
    SET failed_runs = CASE WHEN failed_attempt IS ${attemptId} THEN failed_runs
        WHEN failed_item IS ${item} THEN failed_runs + 1 ELSE 1 END,
      failed_item = ${item}, failed_attempt = ${attemptId}
    WHERE task_id = ${automationId} RETURNING failed_runs`
  return (streak[0]?.failed_runs ?? 0) >= FAILURES_BEFORE_GIVING_UP ? { kind: "streak" } : undefined
})

/** Ends the failure streak: a run did its work, the Automation gave up, or the owner resumed it. */
export const endStreak = (sql: SqlClient.SqlClient, automationId: string) =>
  sql`UPDATE scheduled_tasks SET failed_runs = 0, failed_item = NULL WHERE task_id = ${automationId}`

/** Why a job gave up, for the line that tells the owner. */
export const giveUpReason = (cause: GiveUpCause): string =>
  cause.kind === "lasting" ? cause.said : `it failed ${FAILURES_BEFORE_GIVING_UP} runs in a row`

/**
 * Pauses a user Automation when `givesUp` holds for its failed run, and tells the owner through
 * `recordAutomationEvent`. Answers whether the Automation was paused.
 */
export const pauseOnGivingUp = Effect.fn("AutomationGiveUp.pause")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly sessionEvents: SessionLifecycleEvents["Service"]
  readonly automationId: string
  readonly attemptId: number
  readonly chatRunId: string | null
}) {
  const { sql, automationId } = options
  const cause = yield* givesUp(sql, { ...options, item: null })
  if (cause === undefined) return false
  const live = yield* sql`SELECT task_id FROM scheduled_tasks
    WHERE task_id = ${automationId} AND ${userAutomationSql()} AND enabled = 1`
  if (live.length === 0) return false
  yield* endStreak(sql, automationId)
  yield* haltAutomation({
    sql,
    sessionEvents: options.sessionEvents,
    automationId,
    halt: "pause"
  })
  yield* recordAutomationEvent(sql, {
    sessionEvents: options.sessionEvents,
    automationId,
    attemptId: options.attemptId,
    event: "paused",
    text:
      cause.kind === "streak"
        ? `Paused after ${FAILURES_BEFORE_GIVING_UP} failed runs in a row. Resume it once the cause is fixed.`
        : `Paused: ${cause.said} ${cause.next}`
  })
  return true
})

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
  yield* endStreak(sql, automationId)
  yield* sql`UPDATE automation_deliveries SET payload = json_set(payload, '$.resumedAt', ${at})
    WHERE task_id = ${automationId}
      AND json_extract(payload, '$.kind') IN ('automation_paused', 'automation_space_paused')
      AND json_extract(payload, '$.resumedAt') IS NULL`
})
