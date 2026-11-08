import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"

import type { AutomationRules } from "../automations/model.js"
import type { DispatchInTransaction } from "./automation-event-dispatch.js"
import type { ToldOutcome } from "./run-ending.js"
import type { QueueContext } from "./automation-queue-context.js"

export const raiseRunEnded = Effect.fn("AutomationSettlement.raiseRunEnded")(function* (input: {
  readonly sql: SqlClient.SqlClient
  readonly rules: AutomationRules["Service"]
  readonly dispatch: DispatchInTransaction
  readonly automationId: string
  readonly purpose: "user_automation" | "system"
  readonly attemptId: number
  readonly outcome: ToldOutcome
  readonly text: string
  readonly sessionId: string | null
  readonly context: QueueContext
}) {
  const rows = yield* input.sql<{
    readonly name: string
    readonly automation_ref: string
    readonly public_ref: string | null
  }>`
    SELECT task.name, task.automation_ref, session.public_ref
    FROM scheduled_tasks AS task
    LEFT JOIN sessions AS session ON session.session_id = ${input.sessionId}
    WHERE task.task_id = ${input.automationId}
  `
  const row = rows[0]
  if (row === undefined) return
  const event = input.rules.runEndedEvent({
    attemptId: input.attemptId,
    automationId: input.automationId,
    automationRef: row.automation_ref,
    name: row.name,
    purpose: input.purpose,
    outcome: input.outcome === "blocked" ? "finished" : input.outcome,
    text: input.text,
    chat:
      input.sessionId === null || row.public_ref === null
        ? undefined
        : { sessionId: input.sessionId, publicRef: row.public_ref },
    wokenBy: input.context.trigger_context_snapshot
  })
  if (event !== undefined) yield* input.dispatch(event)
})
