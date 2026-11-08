import type { AutomationTriggerContext } from "@arden-hq/protocol/automations"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { AutomationQueueSource } from "../automations/store.js"
import type { QueueContext } from "./automation-queue-context.js"

export const triggerContextForClaim = (options: {
  readonly context: QueueContext
  readonly source: AutomationQueueSource
  readonly createdAt: string
}): AutomationTriggerContext | undefined => {
  if (options.context.trigger_context_snapshot !== undefined)
    return options.context.trigger_context_snapshot
  const queued_at = options.createdAt
  switch (options.source) {
    case "manual":
      return { source: "manual", queued_at }
    case "wake":
      return { source: "wake", queued_at }
    case "scheduled":
      return options.context.scheduled_for === null
        ? undefined
        : { source: "scheduled", queued_at, scheduled_for: options.context.scheduled_for }
    case "idle":
      return options.context.home_letter_input === undefined
        ? undefined
        : {
            source: "home",
            queued_at,
            window_id: options.context.home_letter_input.snapshot.window.id,
            fingerprint: options.context.home_letter_input.snapshot.fingerprint
          }
    case "count":
    case "event":
      return undefined
  }
}

const occurrenceCauses = (
  context: QueueContext
): ReadonlyArray<Exclude<AutomationTriggerContext, { source: "coalesced" }>> => {
  const snapshot = context.trigger_context_snapshot
  if (snapshot === undefined) return []
  return snapshot.source === "coalesced" ? snapshot.causes : [snapshot]
}

export const answersSchedule = (context: QueueContext, source: AutomationQueueSource): boolean =>
  source === "scheduled" || occurrenceCauses(context).some((cause) => cause.source === "scheduled")

export const consumeIdleInput = Effect.fn("AutomationOccurrence.consumeIdleInput")(
  function* (options: {
    readonly sql: SqlClient.SqlClient
    readonly automationId: string
    readonly context: QueueContext
  }) {
    const sequences = occurrenceCauses(options.context).flatMap((cause) =>
      cause.source === "idle" ? [cause.input_sequence] : []
    )
    if (sequences.length === 0) return
    yield* options.sql`UPDATE automation_idle_state
    SET consumed_input_sequence = MAX(consumed_input_sequence, ${Math.max(...sequences)})
    WHERE task_id = ${options.automationId}`
  }
)
