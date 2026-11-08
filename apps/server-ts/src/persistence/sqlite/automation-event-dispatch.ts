import { Clock, Effect, Schema } from "effect"
import { SqlError } from "effect/unstable/sql"
import { renderEvent } from "../automations/event-text.js"
import {
  wikiChangedRevision,
  type AutomationRules,
  type AutomationTriggerEvent
} from "../automations/model.js"
import { chainMayWake } from "../automations/chain-depth.js"
import { AutomationStoreError } from "../automations/store.js"
import type { AutomationTriggers } from "../automations/triggers.js"
import { WikiEventOutbox } from "../automations/wiki-event-outbox.js"
import { decodeJson, type JsonColumnError } from "./json.js"
import type { SessionLifecycleEventError } from "../sessions/events.js"
import { listenerTriggers } from "./automation-schedule.js"
import { enqueue } from "./automation-enqueue.js"
import { listensFor, listensForEvents, eventBatchOf, matchEvent } from "./automation-listening.js"
import type { QueueContext } from "./automation-queue-context.js"
import type { PersistenceDeps } from "./deps.js"
import { touchCause } from "./effect-targets.js"
import type { UnitOfWork } from "../unit-of-work.js"
import { iso } from "../../runtime/clock.js"

const Revision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))
const Cursor = Schema.Struct({ revision: Schema.NullOr(Revision) })
const storeError = (
  operation: "dispatch_event",
  reason: AutomationStoreError["reason"],
  message: string,
  automationId?: string,
  cause?: unknown
) =>
  new AutomationStoreError({
    operation,
    reason,
    message,
    ...(automationId === undefined ? {} : { automationId }),
    ...(cause === undefined ? {} : { cause })
  })
const failure = (cause: unknown) =>
  cause instanceof AutomationStoreError
    ? cause
    : storeError(
        "dispatch_event",
        "storage",
        "Could not dispatch Automation event",
        undefined,
        cause
      )
export type DispatchInTransaction = (
  event: AutomationTriggerEvent,
  options?: { readonly dueAt?: number }
) => Effect.Effect<
  { readonly queued: number },
  AutomationStoreError | JsonColumnError | SqlError.SqlError | SessionLifecycleEventError,
  UnitOfWork
>

export const makeAutomationEventDispatch = ({
  writer,
  sessionEvents,
  rules
}: Pick<PersistenceDeps, "writer" | "sessionEvents"> & {
  readonly rules: AutomationRules["Service"]
}): {
  readonly dispatchEvent: AutomationTriggers["Service"]["dispatchEvent"]
  readonly dispatchInTransaction: DispatchInTransaction
  readonly outbox: WikiEventOutbox["Service"]
} => {
  const sql = writer.sql
  const dispatchInTransaction = Effect.fn("Automation.dispatchInTransaction")(function* (
    reported: AutomationTriggerEvent,
    options: { readonly dueAt?: number } = {}
  ) {
    const written =
      reported.producedBy === null && reported.touches !== undefined
        ? yield* touchCause(sql, reported.touches)
        : undefined
    const event = written === undefined ? reported : { ...reported, ...written }
    if (!chainMayWake(event.chainDepth)) return { queued: 0 }
    const nowMs = yield* Clock.currentTimeMillis
    const rows = yield* sql<{
      readonly task_id: string
      readonly triggers: string
      readonly purpose: string
      readonly paused_at: string | null
    }>`
      SELECT task_id, triggers, purpose, paused_at
      FROM scheduled_tasks
      WHERE ${listensForEvents(sql, sql`scheduled_tasks`)}
        AND purpose IN ('user_automation', 'system', 'space_review')
      ORDER BY task_id
    `
    let queued = 0
    for (const row of rows) {
      if (row.task_id === event.producedBy) continue
      if (!listensFor({ pausedAt: row.paused_at, eventType: event.eventType })) continue
      const triggers = yield* listenerTriggers(row)
      if (triggers === undefined) continue
      const { matched, runOnlyIf } = matchEvent(rules, triggers, event, row.purpose)
      if (matched.length === 0) continue
      const key = `${event.eventType}:${event.eventKey}`
      const triggeringChange = wikiChangedRevision(event)
      const snapshot = {
        queued_at: iso(nowMs),
        event_type: event.eventType,
        event_key: event.eventKey,
        produced_by: event.producedBy,
        ...(event.chainDepth === 0 ? {} : { chain_depth: event.chainDepth }),
        context: event.context
      }
      const context: QueueContext = {
        scheduled_for: null,
        automation_run_id: null,
        trigger_context: renderEvent(snapshot, nowMs),
        trigger_context_snapshot: { source: "event", ...snapshot },
        ...(triggeringChange === null ? {} : { triggering_change: triggeringChange }),
        ...(runOnlyIf === undefined ? {} : { run_only_if: runOnlyIf })
      }
      const batch = row.paused_at === null ? undefined : eventBatchOf(context, row.paused_at)
      const wrote = yield* enqueue(
        { sql, sessionEvents },
        {
          automationId: row.task_id,
          source: "event",
          key,
          once: key,
          pending: "add",
          ...(options.dueAt === undefined ? {} : { dueAt: options.dueAt }),
          context: batch === undefined ? context : { ...context, event_batch: batch }
        }
      )
      if (wrote) queued += 1
    }
    return { queued }
  })
  const dispatchEvent = Effect.fn("Automation.dispatchEvent")(function* (
    event: AutomationTriggerEvent
  ) {
    return yield* writer.transact(dispatchInTransaction(event)).pipe(Effect.mapError(failure))
  })
  const wikiPublicationCursor = Effect.fn("Automation.wikiPublicationCursor")(function* (
    initialRevision: string | null
  ) {
    const initial = yield* Schema.decodeUnknownEffect(Cursor)({ revision: initialRevision }).pipe(
      Effect.mapError(failure)
    )
    return yield* writer
      .transact(
        Effect.gen(function* () {
          yield* sql`INSERT INTO monitor_state (namespace, state, updated_at)
        VALUES ('wiki_publication', ${JSON.stringify(initial)}, ${iso(yield* Clock.currentTimeMillis)})
        ON CONFLICT(namespace) DO NOTHING`
          const rows = yield* sql<{
            readonly state: string
          }>`SELECT state FROM monitor_state WHERE namespace = 'wiki_publication'`
          if (rows[0] === undefined)
            return yield* storeError(
              "dispatch_event",
              "corrupt",
              "Wiki publication cursor is missing"
            )
          return (yield* decodeJson(Cursor, rows[0].state)).revision
        })
      )
      .pipe(Effect.mapError(failure))
  })
  const publishWikiChange = Effect.fn("Automation.publishWikiChange")(function* (input: {
    readonly previousRevision: string | null
    readonly revision: string
    readonly event: AutomationTriggerEvent | undefined
  }) {
    const expected = yield* Schema.decodeUnknownEffect(Cursor)({
      revision: input.previousRevision
    }).pipe(Effect.mapError(failure))
    const next = yield* Schema.decodeUnknownEffect(Revision)(input.revision).pipe(
      Effect.mapError(failure)
    )
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const advanced = yield* sql<{ readonly namespace: string }>`UPDATE monitor_state
        SET state = ${JSON.stringify({ revision: next })}, updated_at = ${iso(yield* Clock.currentTimeMillis)}
        WHERE namespace = 'wiki_publication' AND state = ${JSON.stringify(expected)}
        RETURNING namespace`
          if (advanced.length === 0) return null
          return input.event === undefined
            ? { queued: 0 }
            : yield* dispatchInTransaction(input.event)
        })
      )
      .pipe(Effect.mapError(failure))
  })
  return {
    dispatchEvent,
    dispatchInTransaction,
    outbox: WikiEventOutbox.of({ wikiPublicationCursor, publishWikiChange })
  }
}
