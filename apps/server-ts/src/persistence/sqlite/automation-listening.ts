import type { SqlClient, Statement } from "effect/unstable/sql"

import {
  isAutomationEventType,
  type AutomationTrigger,
  type EventAutomationTrigger
} from "@arden-hq/protocol/automations"
import type { AutomationRules, AutomationTriggerEvent } from "../automations/model.js"
import { runOnlyIfSentences } from "../automations/event-words.js"
import { isUserAutomationPurpose } from "../job-classification.js"
import type { EventBatch } from "../automations/event-batch.js"
import type { QueueContext } from "./automation-queue-context.js"

export const listensForEvents = (sql: SqlClient.SqlClient, table: Statement.Fragment) =>
  sql`(${table}.enabled = 1 OR ${table}.paused_at IS NOT NULL)`

export const queuedEventType = (
  sql: SqlClient.SqlClient,
  context: Statement.Fragment = sql`context`
) => sql`json_extract(${context}, '$.trigger_context_snapshot.event_type')`

export const eventBatchOf = (
  context: QueueContext,
  pausedSince?: string
): EventBatch | undefined => {
  if (context.event_batch !== undefined)
    return { ...context.event_batch, overflow: context.event_batch.overflow ?? [] }
  const snapshot = context.trigger_context_snapshot
  if (snapshot?.source !== "event") return undefined
  const { source: _source, ...event } = snapshot
  return {
    events: [
      context.run_only_if === undefined ? event : { ...event, run_only_if: context.run_only_if }
    ],
    overflow: [],
    omitted: 0,
    ...(pausedSince === undefined ? {} : { paused_since: pausedSince })
  }
}

export const listensFor = (input: {
  readonly pausedAt: string | null
  readonly eventType: string
}): boolean => input.pausedAt === null || input.eventType !== "chat.quiet"

export const batchSize = (batch: QueueContext["event_batch"]): number =>
  batch === undefined ? 1 : batch.events.length + (batch.overflow?.length ?? 0)

export const matchEvent = (
  rules: AutomationRules["Service"],
  triggers: ReadonlyArray<AutomationTrigger>,
  event: AutomationTriggerEvent,
  purpose: string
) => {
  const matched = triggers.filter(
    (trigger): trigger is EventAutomationTrigger =>
      trigger.type === "event" && rules.eventMatches(trigger, event)
  )
  return {
    matched,
    runOnlyIf:
      matched.length > 0 && isUserAutomationPurpose(purpose)
        ? runOnlyIfSentences(matched)
        : undefined
  }
}

export const eventFromSnapshot = (context: QueueContext): AutomationTriggerEvent | undefined => {
  const snapshot = context.trigger_context_snapshot
  if (snapshot?.source !== "event" || !isAutomationEventType(snapshot.event_type)) return undefined
  return {
    eventType: snapshot.event_type,
    eventKey: snapshot.event_key,
    producedBy: snapshot.produced_by,
    chainDepth: snapshot.chain_depth ?? 0,
    context: snapshot.context
  }
}
