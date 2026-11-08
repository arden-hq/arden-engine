import type { AutomationTriggerContext } from "@arden-hq/protocol/automations"
import { Clock, Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"

import type { AutomationQueueSource } from "../automations/store.js"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import { iso } from "../../runtime/clock.js"
import { EVENTS_PER_SOURCE, runsAlone } from "../automations/event-batch.js"
import { batchSize, eventBatchOf, queuedEventType } from "./automation-listening.js"
import { triggerContextForClaim } from "./automation-occurrence.js"
import { QueueContextSchema, type QueueContext } from "./automation-queue-context.js"
import { countsAsRun } from "./automation-skip-record.js"
import { decodeJson, encodeJson } from "./json.js"

export interface QueueWriter {
  readonly sql: SqlClient.SqlClient
  readonly sessionEvents: SessionLifecycleEvents["Service"]
}

export interface QueueEntry {
  readonly automationId: string
  readonly source: AutomationQueueSource
  readonly key: string
  readonly context: QueueContext
  readonly dueAt?: number
  readonly pending: "add" | "replace" | "merge"
  readonly once?: string
}

const DEDUPE_KEEP_MS = 7 * 24 * 60 * 60_000

export interface BatchWindow {
  readonly quietMs: number
  readonly maxWaitMs: number
}

const SPACE_REVIEW_WINDOW: BatchWindow = { quietMs: 10 * 60_000, maxWaitMs: 30 * 60_000 }
const HOME_WINDOW: BatchWindow = { quietMs: 30_000, maxWaitMs: 120_000 }

export const batchWindow = (job: {
  readonly purpose: string
  readonly handler: string | null
}): BatchWindow | undefined => {
  if (job.purpose === "space_review") return SPACE_REVIEW_WINDOW
  if (job.handler === "home_letter") return HOME_WINDOW
  return undefined
}

const runsAtOnce = (source: AutomationQueueSource): boolean =>
  source === "manual" || source === "scheduled"

const firedByTrigger = (source: AutomationQueueSource): boolean =>
  source === "event" || source === "idle" || source === "count"

export const freshRow = (sql: SqlClient.SqlClient) =>
  sql`claimed_at IS NULL AND attempt_count = 0
    AND json_extract(context, '$.automation_run_id') IS NULL`

export const cooldownEnd = Effect.fn("AutomationQueue.cooldownEnd")(function* (
  sql: SqlClient.SqlClient,
  automationId: string
) {
  const rows = yield* sql<{ readonly minutes: number | null; readonly ended: string | null }>`
    SELECT task.cooldown_minutes AS minutes,
      (SELECT MAX(run.ended_at) FROM automation_runs AS run
        WHERE run.task_id = task.task_id AND run.ended_at IS NOT NULL
          AND ${countsAsRun(sql, sql`run`)}) AS ended
    FROM scheduled_tasks AS task WHERE task.task_id = ${automationId}`
  const row = rows[0]
  if (row === undefined || row.minutes === null || row.minutes <= 0 || row.ended === null)
    return undefined
  const endedMs = Date.parse(row.ended)
  return Number.isFinite(endedMs) ? endedMs + row.minutes * 60_000 : undefined
})

export const holdForCooldown = Effect.fn("AutomationQueue.holdForCooldown")(function* (
  sql: SqlClient.SqlClient,
  row: { readonly id: number; readonly task_id: string; readonly source: AutomationQueueSource },
  nowMs: number
) {
  if (!firedByTrigger(row.source)) return false
  const until = yield* cooldownEnd(sql, row.task_id)
  if (until === undefined || until <= nowMs) return false
  yield* sql`UPDATE automation_event_queue SET next_attempt_at = ${iso(until)} WHERE id = ${row.id}`
  return true
})

export const enqueue = Effect.fn("AutomationQueue.enqueue")(function* (
  { sql, sessionEvents }: QueueWriter,
  entry: QueueEntry
) {
  const nowMs = yield* Clock.currentTimeMillis
  const now = iso(nowMs)
  if (entry.once !== undefined) {
    yield* sql`DELETE FROM automation_event_dedupe WHERE seen_at < ${iso(nowMs - DEDUPE_KEEP_MS)}`
    const claimed = yield* sql<{ readonly task_id: string }>`
      INSERT INTO automation_event_dedupe (task_id, event_key, seen_at)
      VALUES (${entry.automationId}, ${entry.once}, ${now})
      ON CONFLICT (task_id, event_key) DO NOTHING
      RETURNING task_id`
    if (claimed.length === 0) return false
  }
  const jobs = yield* sql<{ readonly purpose: string; readonly handler: string | null }>`
    SELECT purpose, handler FROM scheduled_tasks WHERE task_id = ${entry.automationId}`
  const job = jobs[0]
  const window =
    job === undefined || runsAtOnce(entry.source) || entry.dueAt !== undefined
      ? undefined
      : batchWindow(job)
  const cooldown = firedByTrigger(entry.source)
    ? yield* cooldownEnd(sql, entry.automationId)
    : undefined
  const batchedUntil =
    window === undefined ? undefined : yield* batchHold(sql, entry.automationId, window, nowMs)
  const asked = entry.dueAt ?? nowMs
  const dueMs = Math.max(asked, cooldown ?? asked, batchedUntil ?? asked)
  const due = dueMs > nowMs || entry.dueAt !== undefined ? iso(dueMs) : null
  const written = entry.pending === "add" ? undefined : yield* replacePending(sql, entry, due)
  if (written === undefined) {
    const context = yield* encodeJson(QueueContextSchema, entry.context)
    yield* sql`
      INSERT INTO automation_event_queue (
        task_id, source, event_key, context, created_at, claimed_at,
        attempt_count, last_error, next_attempt_at
      ) VALUES (
        ${entry.automationId}, ${entry.source}, ${entry.key}, ${context}, ${now},
        NULL, 0, NULL, ${due}
      )`
  }
  if (entry.source === "event") yield* capWaitingEvents(sql, entry)
  if (window !== undefined && due !== null)
    yield* sql`UPDATE automation_event_queue SET next_attempt_at = ${due}
      WHERE task_id = ${entry.automationId} AND ${freshRow(sql)}
        AND source NOT IN ('manual', 'scheduled')
        AND (next_attempt_at IS NULL OR next_attempt_at < ${due})`
  const cause = queuedCause(entry)
  yield* sessionEvents.appendEventInTransaction({
    type: "automation_queued",
    event_type: cause.eventType,
    event_key: entry.key,
    queued: 1,
    produced_by: cause.producedBy,
    chain_depth: cause.chainDepth
  })
  return true
})

const capWaitingEvents = Effect.fn("AutomationQueue.capWaitingEvents")(function* (
  sql: SqlClient.SqlClient,
  entry: QueueEntry
) {
  const snapshot = entry.context.trigger_context_snapshot
  if (snapshot?.source !== "event") return
  const type = snapshot.event_type
  if (runsAlone(type)) return
  const waiting = sql`task_id = ${entry.automationId} AND source = 'event' AND ${freshRow(sql)}
    AND ${queuedEventType(sql)} = ${type}`
  const total = (yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS n FROM automation_event_queue WHERE ${waiting}`)[0]?.n
  if (total === undefined || total <= EVENTS_PER_SOURCE) return
  const extra = yield* sql<{ readonly id: number; readonly context: string }>`
    SELECT id, context FROM automation_event_queue WHERE ${waiting}
    ORDER BY id DESC LIMIT -1 OFFSET ${EVENTS_PER_SOURCE}`
  const newest = (yield* sql<{ readonly id: number; readonly context: string }>`
    SELECT id, context FROM automation_event_queue WHERE ${waiting}
    ORDER BY id DESC LIMIT 1`)[0]
  if (newest === undefined) return
  const dropped = yield* Effect.forEach(extra, (row) => decodeJson(QueueContextSchema, row.context))
  const kept = yield* decodeJson(QueueContextSchema, newest.context)
  const batch = eventBatchOf(kept)
  if (batch === undefined) return
  const pausedSince = [kept, ...dropped]
    .flatMap((context) => context.event_batch?.paused_since ?? [])
    .toSorted()[0]
  const omitted =
    batch.omitted +
    dropped.reduce(
      (sum, row) => sum + batchSize(row.event_batch) + (row.event_batch?.omitted ?? 0),
      0
    )
  const next: QueueContext = {
    ...kept,
    event_batch: {
      ...batch,
      omitted,
      ...(pausedSince === undefined ? {} : { paused_since: pausedSince })
    }
  }
  yield* sql`DELETE FROM automation_event_queue WHERE id IN ${sql.in(extra.map(({ id }) => id))}`
  yield* sql`UPDATE automation_event_queue
    SET context = ${yield* encodeJson(QueueContextSchema, next)} WHERE id = ${newest.id}`
})

const batchHold = Effect.fn("AutomationQueue.batchHold")(function* (
  sql: SqlClient.SqlClient,
  automationId: string,
  window: BatchWindow,
  nowMs: number
) {
  const first = yield* sql<{ readonly first: string | null }>`
    SELECT MIN(created_at) AS first FROM automation_event_queue
    WHERE task_id = ${automationId} AND ${freshRow(sql)}
      AND source NOT IN ('manual', 'scheduled')`
  const firstMs = first[0]?.first == null ? nowMs : Date.parse(first[0].first)
  return Math.min(nowMs + window.quietMs, firstMs + window.maxWaitMs)
})

const replacePending = Effect.fn("AutomationQueue.replacePending")(function* (
  sql: SqlClient.SqlClient,
  entry: QueueEntry,
  due: string | null
) {
  const pending = yield* sql<{
    readonly id: number
    readonly context: string
    readonly created_at: string
  }>`
    SELECT id, context, created_at FROM automation_event_queue
    WHERE task_id = ${entry.automationId} AND source = ${entry.source}
      AND event_key = ${entry.key} AND ${freshRow(sql)}
    ORDER BY id LIMIT 1`
  const row = pending[0]
  if (row === undefined) return undefined
  const context =
    entry.pending === "merge"
      ? mergedContext(entry, yield* decodeJson(QueueContextSchema, row.context), row.created_at)
      : entry.context
  yield* sql`UPDATE automation_event_queue
    SET context = ${yield* encodeJson(QueueContextSchema, context)}, next_attempt_at = ${due}
    WHERE id = ${row.id}`
  return row.id
})

const mergedContext = (
  entry: QueueEntry,
  prior: QueueContext,
  priorCreatedAt: string
): QueueContext => {
  const before = triggerContextForClaim({
    context: prior,
    source: entry.source,
    createdAt: priorCreatedAt
  })
  const causes = [before, entry.context.trigger_context_snapshot].flatMap(
    (trigger): ReadonlyArray<Exclude<AutomationTriggerContext, { source: "coalesced" }>> => {
      if (trigger === undefined) return []
      return trigger.source === "coalesced" ? trigger.causes : [trigger]
    }
  )
  const [first, ...rest] = causes
  return {
    ...prior,
    ...entry.context,
    ...(first === undefined
      ? {}
      : {
          trigger_context_snapshot:
            rest.length === 0
              ? first
              : { source: "coalesced", queued_at: priorCreatedAt, causes: [first, ...rest] }
        })
  }
}

const queuedCause = (entry: QueueEntry) => {
  const snapshot = entry.context.trigger_context_snapshot
  return snapshot?.source === "event"
    ? {
        eventType: snapshot.event_type,
        producedBy: snapshot.produced_by,
        chainDepth: snapshot.chain_depth ?? 0
      }
    : { eventType: entry.source, producedBy: null, chainDepth: 0 }
}
