import { cutText, firstLine } from "@arden-hq/std/text"
import { captureMutationVersions } from "./mutation-links.js"
import type { MutationOperationIdentity } from "../tools/mutation-receipt.js"
import { outcomeSql } from "./automation-run-outcome.js"
import { countsAsRun } from "./automation-skip-record.js"
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
 * FAILURES_BEFORE_GIVING_UP-th failed run in a row since the Automation last gave up.
 */
export const givesUp = Effect.fn("AutomationGiveUp.givesUp")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly automationId: string
    readonly attemptId: number
    readonly chatRunId: string | null
  }
): Effect.fn.Return<GiveUpCause | undefined, SqlError.SqlError> {
  const { automationId } = input
  const lasting = yield* sql<{ readonly error_code: string | null; readonly error: string | null }>`
    SELECT chat.error_code, COALESCE(chat.error_message, attempt.error) AS error
    FROM chat_runs AS chat JOIN automation_runs AS attempt ON attempt.id = ${input.attemptId}
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
  const before = yield* sql<{ readonly outcome: string }>`
    SELECT outcome FROM (SELECT id, ${outcomeSql(sql, sql`automation_runs`)} AS outcome
      FROM automation_runs
      WHERE task_id = ${automationId} AND id < ${input.attemptId} AND ended_at IS NOT NULL
        AND ${countsAsRun(sql, sql`automation_runs`)}
        AND id > MAX(
          (SELECT COALESCE(MAX(json_extract(payload, '$.attemptId')), 0)
            FROM automation_deliveries
            WHERE task_id = ${automationId}
              AND json_extract(payload, '$.kind') = 'automation_paused'),
          (SELECT COALESCE(MAX(skipped.id), 0)
            FROM automation_runs AS skipped
            JOIN entity_events AS event ON event.run_id = skipped.chat_run_id
            WHERE skipped.task_id = ${automationId}
              AND event.entity = 'automation' AND event.event = 'failed')))
    WHERE outcome NOT IN ('cancelled', 'interrupted')
    ORDER BY id DESC LIMIT ${FAILURES_BEFORE_GIVING_UP - 1}`
  return before.length === FAILURES_BEFORE_GIVING_UP - 1 &&
    before.every((run) => run.outcome === "failed")
    ? { kind: "streak" }
    : undefined
})

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
  const cause = yield* givesUp(sql, options)
  if (cause === undefined) return false
  const live = yield* sql`SELECT task_id FROM scheduled_tasks
    WHERE task_id = ${automationId} AND ${userAutomationSql()} AND enabled = 1`
  if (live.length === 0) return false
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
  yield* sql`UPDATE automation_deliveries SET payload = json_set(payload, '$.resumedAt', ${at})
    WHERE task_id = ${automationId}
      AND json_extract(payload, '$.kind') IN ('automation_paused', 'automation_space_paused')
      AND json_extract(payload, '$.resumedAt') IS NULL`
})
