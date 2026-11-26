import { openRunSince } from "./automation-running.js"
import { isAutomationEventType } from "@arden-hq/protocol/automations"
import { AutomationTriggerContextSchema } from "@arden-hq/protocol/effect/automations"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import {
  mergeEventBatches,
  RUNS_ALONE,
  runsAlone,
  type BatchedEvent,
  type EventBatch,
  type RunEvents
} from "../automations/event-batch.js"
import { renderEvent, renderEvents } from "../automations/event-text.js"
import { skippedEventOf } from "../automations/event-words.js"
import type {
  AutomationJobPayload,
  AutomationJobPrefilterEvent,
  AutomationQueueSource
} from "../automations/store.js"
import type { AutomationQueue } from "../automations/queue.js"
import { batchWindow, freshRow } from "./automation-enqueue.js"
import { eventBatchOf, queuedEventType } from "./automation-listening.js"
import { triggerContextForClaim } from "./automation-occurrence.js"
import type { QueueContext } from "./automation-queue-context.js"
import { decodeJson } from "./json.js"
import { storeError, type AutomationStoreDeps } from "./automation-rows.js"
import { isUserAutomationPurpose } from "../job-classification.js"
import type { Row } from "effect/unstable/sql/SqlConnection"
import type { Statement } from "effect/unstable/sql/Statement"
import { decodeQueueContext } from "./automation-queue-context.js"
import { batchedEventOf, eventCauseOf } from "../automations/event-cause.js"

export const batchAtClaim = Effect.fn("AutomationEventBatch.batchAtClaim")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly row: {
    readonly id: number
    readonly task_id: string
    readonly purpose: string
    readonly handler: string | null
    readonly source: AutomationQueueSource
    readonly attempt_count: number
    readonly cooldown_minutes: number | null
    readonly created_at: string
  }
  readonly context: QueueContext
  readonly now: string
}) {
  const { row } = options
  if (
    options.context.trigger_context_snapshot?.source === "event" &&
    runsAlone(options.context.trigger_context_snapshot.event_type)
  )
    return options.context
  if (row.handler === "wiki_maintenance") return yield* absorbMemoryChanges(options)
  if (batchWindow(row) !== undefined) return yield* absorbBatch(options)
  if (
    (row.source === "event" || row.source === "manual") &&
    isUserAutomationPurpose(row.purpose) &&
    row.attempt_count === 0
  )
    return yield* absorbWaitingEvents(options)
  return options.context
})

const absorbBatch = Effect.fn("AutomationEventBatch.absorbBatch")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly row: {
    readonly id: number
    readonly task_id: string
    readonly source: AutomationQueueSource
    readonly created_at: string
  }
  readonly context: QueueContext
  readonly now: string
}) {
  const { sql, row } = options
  const run = { depth: contextDepth(options.context), asked: row.source === "manual" }
  const rows = yield* sql<{
    readonly id: number
    readonly source: AutomationQueueSource
    readonly context: string
    readonly created_at: string
    readonly due: number
    readonly held: number
  }>`
    SELECT queue.id, queue.source, queue.context, queue.created_at,
      ${foldFacts(sql, options.now)}
    FROM automation_event_queue AS queue
    WHERE queue.task_id = ${row.task_id} AND queue.id != ${row.id}
      AND ${queuedEventType(sql, sql`queue.context`)} IS NOT ${RUNS_ALONE}
      AND ${freshRow(sql)}
    ORDER BY queue.id`
  const decoded = yield* Effect.forEach(rows, (other) =>
    decodeQueueContext({ context: other.context, task_id: row.task_id }, "claim").pipe(
      Effect.map((context) => ({ ...other, context }))
    )
  )
  const waiting = decoded.filter((other) =>
    foldsInto(run, {
      depth: contextDepth(other.context),
      due: other.due === 1,
      held: other.held === 1
    })
  )
  if (waiting.length === 0) return options.context
  const others = waiting.map((other) =>
    triggerContextForClaim({
      context: other.context,
      source: other.source,
      createdAt: other.created_at
    })
  )
  yield* sql`DELETE FROM automation_event_queue WHERE id IN ${sql.in(waiting.map(({ id }) => id))}`
  const own = triggerContextForClaim({
    context: options.context,
    source: row.source,
    createdAt: row.created_at
  })
  const causes = [own, ...others].flatMap((trigger) => {
    if (trigger === undefined) return []
    return trigger.source === "coalesced" ? trigger.causes : [trigger]
  })
  const [first, ...rest] = [
    ...new Map(causes.map((cause) => [JSON.stringify(cause), cause])).values()
  ]
  if (first === undefined) return options.context
  return {
    ...options.context,
    trigger_context_snapshot:
      rest.length === 0
        ? first
        : { source: "coalesced", queued_at: row.created_at, causes: [first, ...rest] }
  } satisfies QueueContext
})

const absorbMemoryChanges = Effect.fn("AutomationEventBatch.absorbMemoryChanges")(
  function* (options: {
    readonly sql: SqlClient.SqlClient
    readonly row: {
      readonly id: number
      readonly task_id: string
      readonly source: AutomationQueueSource
      readonly created_at: string
    }
    readonly context: QueueContext
    readonly now: string
  }) {
    const { sql, row } = options
    const own = eventBatchOf(options.context)
    const run = { depth: contextDepth(options.context), asked: row.source === "manual" }
    const waiting = yield* sql<{
      readonly id: number
      readonly context: string
      readonly due: number
      readonly held: number
    }>`
      SELECT queue.id, queue.context, ${foldFacts(sql, options.now)}
      FROM automation_event_queue AS queue
      WHERE queue.task_id = ${row.task_id} AND queue.id != ${row.id} AND queue.source = 'event'
        AND ${queuedEventType(sql, sql`queue.context`)} = 'wiki.changed' AND ${freshRow(sql)}
      ORDER BY queue.id`
    const decoded = yield* Effect.forEach(waiting, (other) =>
      decodeQueueContext({ context: other.context, task_id: row.task_id }, "claim").pipe(
        Effect.map((context) => ({
          id: other.id,
          due: other.due === 1,
          held: other.held === 1,
          batch: eventBatchOf(context)
        }))
      )
    )
    const folded = decoded.flatMap(({ batch, ...other }) =>
      batch !== undefined && foldsInto(run, { ...other, depth: batchChainDepth(batch) })
        ? [{ id: other.id, batch }]
        : []
    )
    if (folded.length === 0) return options.context
    yield* sql`DELETE FROM automation_event_queue WHERE id IN ${sql.in(folded.map(({ id }) => id))}`
    const merged = mergeEventBatches([
      ...(own === undefined ? [] : [own]),
      ...folded.map(({ batch }) => batch)
    ])
    if (merged === undefined) return options.context
    const trigger =
      own === undefined
        ? triggerContextForClaim({
            context: options.context,
            source: row.source,
            createdAt: row.created_at
          })
        : undefined
    const ownCauses = (trigger === undefined ? [] : [trigger]).flatMap((cause) =>
      cause.source === "coalesced" ? cause.causes : [cause]
    )
    const [first, ...more] = merged.events
    const [head, ...tail] = [
      ...ownCauses,
      ...[first, ...more, ...merged.overflow].map(eventCauseOf)
    ]
    if (head === undefined) return options.context
    return {
      ...options.context,
      event_batch: merged,
      trigger_context_snapshot: {
        source: "coalesced",
        queued_at: row.created_at,
        causes: [head, ...tail]
      }
    } satisfies QueueContext
  }
)

/** A Memory change waits while the Automation that made it still runs, so the
 * run it wakes reads the producer's finished work. The claim and both fold
 * paths read this one fragment. */
export const heldBehindProducer = (sql: SqlClient.SqlClient, queue: string): Statement<Row> => {
  const alias = sql.literal(queue)
  return sql`(${alias}.source = 'event'
    AND ${queuedEventType(sql, sql`${alias}.context`)} = 'wiki.changed'
    AND ${openRunSince(sql, sql`json_extract(${alias}.context, '$.trigger_context_snapshot.produced_by.automation_id')`)} IS NOT NULL)`
}

const foldFacts = (sql: SqlClient.SqlClient, now: string) =>
  sql`(queue.next_attempt_at IS NULL OR queue.next_attempt_at <= ${now}) AS due,
    ${heldBehindProducer(sql, "queue")} AS held`

/** The one rule for which waiting row a claim takes into its run, on all three
 * fold paths: one that could start a run of its own now (due, or the run was
 * asked for by hand, and not held behind its producer) at the run's own chain
 * depth. A deeper event would lift the run's depth, and what the run writes
 * would then wake no one. */
const foldsInto = (
  run: { readonly depth: number; readonly asked: boolean },
  waiting: { readonly depth: number; readonly due: boolean; readonly held: boolean }
): boolean => (run.asked || waiting.due) && !waiting.held && waiting.depth === run.depth

export const withEventText = (
  context: QueueContext,
  now: number,
  cooldownMinutes: number | null
): QueueContext => {
  const batch = eventBatchOf(context)
  return batch === undefined
    ? context
    : {
        ...context,
        trigger_context: renderEvents(batch, textOptions(context, now, cooldownMinutes))
      }
}

export const textOptions = (
  context: QueueContext,
  now: number,
  cooldownMinutes: number | null
): { now: number; afterCooldown: boolean } => {
  const snapshot = context.trigger_context_snapshot
  const manual =
    snapshot?.source === "coalesced" && snapshot.causes.some((c) => c.source === "manual")
  return { now, afterCooldown: (cooldownMinutes ?? 0) > 0 && !manual }
}

export const jobPrefilter = (
  context: QueueContext,
  now: number
): AutomationJobPayload["prefilter"] => {
  const batch = eventBatchOf(context)
  if (batch === undefined) return null
  const [first, ...rest] = batch.events.map((event) => prefilterEvent(event, now))
  if (first === undefined || ![first, ...rest].some((event) => event.sentences !== null))
    return null
  return { events: [first, ...rest] }
}

const prefilterEvent = (event: BatchedEvent, now: number): AutomationJobPrefilterEvent => {
  const key = eventKeyOf(event)
  if (event.run_only_if === undefined || !isAutomationEventType(event.event_type))
    return { key, sentences: null }
  return {
    key,
    sentences: event.run_only_if,
    prompt: renderEvent(event, now),
    event: skippedEventOf(event.event_type, event.context)
  }
}

export const eventKeyOf = (event: BatchedEvent): string => `${event.event_type}:${event.event_key}`

const absorbWaitingEvents = Effect.fn("AutomationEventBatch.absorbWaitingEvents")(
  function* (options: {
    readonly sql: SqlClient.SqlClient
    readonly row: {
      readonly id: number
      readonly task_id: string
      readonly source: AutomationQueueSource
      readonly created_at: string
    }
    readonly context: QueueContext
    readonly now: string
  }) {
    const { sql, row } = options
    if (options.context.from_skipped_run !== undefined) return options.context
    const claimedManual = row.source === "manual"
    const own = claimedManual ? undefined : eventBatchOf(options.context)
    if (own === undefined && !claimedManual) return options.context
    const waiting = yield* sql<{
      readonly id: number
      readonly source: AutomationQueueSource
      readonly context: string
      readonly created_at: string
      readonly due: number
      readonly held: number
    }>`
      SELECT queue.id, queue.source, queue.context, queue.created_at,
        ${foldFacts(sql, options.now)}
      FROM automation_event_queue AS queue
      WHERE queue.task_id = ${row.task_id} AND queue.id != ${row.id}
        AND queue.source IN ('event', 'manual') AND ${freshRow(sql)}
      ORDER BY queue.id`
    const decoded = yield* Effect.forEach(waiting, (other) =>
      decodeQueueContext({ context: other.context, task_id: row.task_id }, "claim").pipe(
        Effect.map((context) => ({
          id: other.id,
          source: other.source,
          createdAt: other.created_at,
          due: other.due === 1,
          held: other.held === 1,
          context,
          batch: other.source === "event" ? eventBatchOf(context) : undefined
        }))
      )
    )
    const manualRows = decoded.filter(
      ({ source, due, context }) =>
        source === "manual" && due && context.from_skipped_run === undefined
    )
    const manual = claimedManual || manualRows.length > 0
    const run = { depth: own === undefined ? 0 : batchChainDepth(own), asked: manual }
    const folded = decoded.flatMap(({ id, source, due, held, batch }) =>
      source === "event" &&
      batch !== undefined &&
      foldsInto(run, { depth: batchChainDepth(batch), due, held })
        ? [{ id, batch: manual ? unasked(batch) : batch }]
        : []
    )
    const ids = [...folded.map(({ id }) => id), ...manualRows.map(({ id }) => id)]
    if (ids.length === 0) return options.context
    yield* sql`DELETE FROM automation_event_queue WHERE id IN ${sql.in(ids)}`
    const merged = mergeEventBatches([
      ...(own === undefined ? [] : [manual ? unasked(own) : own]),
      ...folded.map(({ batch }) => batch)
    ])
    if (merged === undefined) return options.context
    const { run_only_if: _perEvent, ...rest } = options.context
    const [first, ...more] = merged.events
    const causes = [first, ...more, ...merged.overflow].map(eventCauseOf)
    const queuedAt = claimedManual
      ? row.created_at
      : manualRows.map(({ createdAt }) => createdAt).toSorted()[0]
    const [head, ...tail] = manual
      ? [{ source: "manual", queued_at: queuedAt ?? row.created_at } as const, ...causes]
      : causes
    return {
      ...rest,
      event_batch: merged,
      trigger_context_snapshot: {
        source: "coalesced",
        queued_at: row.created_at,
        causes: [head, ...tail]
      }
    } satisfies QueueContext
  }
)

const unasked = (batch: EventBatch): EventBatch => ({
  ...batch,
  events: [stripAsked(batch.events[0]), ...batch.events.slice(1).map(stripAsked)],
  overflow: batch.overflow.map(stripAsked)
})

const stripAsked = ({ run_only_if: _asked, ...event }: BatchedEvent): BatchedEvent => event

const batchChainDepth = (batch: EventBatch): number =>
  Math.max(0, ...[...batch.events, ...batch.overflow].map((event) => event.chain_depth ?? 0))

/** A row that carries no event, a timer or a request by hand, is at depth 0. */
const contextDepth = (context: QueueContext): number => {
  const batch = eventBatchOf(context)
  return batch === undefined ? 0 : batchChainDepth(batch)
}

interface RunAttemptRow {
  readonly task_id: string
  readonly started_at: string
  readonly trigger_json: string | null
  readonly occurrence: string | null
}

export const makeRunEvents = ({
  reader
}: Pick<AutomationStoreDeps, "reader">): AutomationQueue["Service"]["runEvents"] =>
  Effect.fn("AutomationEventBatch.runEvents")(
    function* (input) {
      const own = yield* reader<RunAttemptRow>`
        SELECT attempt.task_id, attempt.started_at, attempt.trigger_json,
               json_extract(attempt.origin, '$.occurrence_id') AS occurrence
        FROM chat_runs AS run
        JOIN automation_runs AS attempt ON attempt.chat_session_id = run.session_id
          AND json_extract(run.metadata_json, '$.run_context.origin') = json(attempt.origin)
        WHERE run.run_id = ${input.chatRunId} AND run.session_id = ${input.sessionId}
        ORDER BY attempt.id DESC LIMIT 1`
      const latest =
        own[0] === undefined
          ? yield* reader<RunAttemptRow>`
              SELECT attempt.task_id, attempt.started_at, attempt.trigger_json,
                     json_extract(attempt.origin, '$.occurrence_id') AS occurrence
              FROM chat_runs AS run
              JOIN automation_runs AS attempt ON attempt.chat_run_id = run.run_id
              WHERE run.session_id = ${input.sessionId}
              ORDER BY run.started_at DESC, run.run_id DESC LIMIT 1`
          : []
      const attempt = own[0] ?? latest[0]
      if (attempt === undefined) return undefined
      const run: RunEvents["run"] = own[0] === undefined ? "latest_in_chat" : "this_run"
      if (attempt.trigger_json === null) return { run, startedAt: attempt.started_at, events: [] }
      const trigger = yield* decodeJson(AutomationTriggerContextSchema, attempt.trigger_json)
      const causes = trigger.source === "coalesced" ? trigger.causes : ([trigger] as const)
      const events = causes.flatMap((cause): ReadonlyArray<BatchedEvent> =>
        cause.source === "event" ? [batchedEventOf(cause)] : []
      )
      if (attempt.occurrence === null) return { run, startedAt: attempt.started_at, events }
      const prefix = `${attempt.occurrence}#`
      const skipped = yield* reader<{ readonly occurrence: string }>`
        SELECT json_extract(origin, '$.occurrence_id') AS occurrence FROM automation_runs
        WHERE task_id = ${attempt.task_id}
          AND json_extract(skip_json, '$.reason') = 'prefilter'
          AND substr(json_extract(origin, '$.occurrence_id'), 1, ${prefix.length}) = ${prefix}`
      const skippedKeys = new Set(skipped.map((row) => row.occurrence.slice(prefix.length)))
      return {
        run,
        startedAt: attempt.started_at,
        events: events.filter((event) => !skippedKeys.has(eventKeyOf(event)))
      }
    },
    Effect.mapError((cause) =>
      storeError("runs", "storage", "Could not read the events of this run", undefined, cause)
    )
  )
