import type { JsonValue } from "@arden-hq/protocol"
import { Predicate } from "effect"

export interface BatchedEvent {
  readonly event_type: string
  readonly event_key: string
  readonly queued_at: string
  readonly produced_by: string | null
  readonly chain_depth?: number
  readonly context: { readonly [field: string]: JsonValue }
  readonly run_only_if?: readonly [string, ...Array<string>]
}

export interface EventBatch {
  readonly events: readonly [BatchedEvent, ...Array<BatchedEvent>]
  readonly overflow: ReadonlyArray<BatchedEvent>
  readonly omitted: number
  readonly unchecked?: number
  readonly paused_since?: string
}

export const KEPT_EVENTS = 50

export const RUNS_ALONE = "space.proposal_review_requested"

export const runsAlone = (eventType: string): boolean => eventType === RUNS_ALONE

export const EVENTS_PER_SOURCE = 128

export const mergeEventBatches = (batches: ReadonlyArray<EventBatch>): EventBatch | undefined => {
  const newestFirst = batches
    .flatMap((batch) => [...batch.events, ...batch.overflow])
    .toSorted((left, right) => Date.parse(right.queued_at) - Date.parse(left.queued_at))
  const seen = new Set<string>()
  const perType = new Map<string, number>()
  let dropped = 0
  const kept = newestFirst.filter((event) => {
    const identity = identityOf(event)
    if (seen.has(identity)) return false
    seen.add(identity)
    const count = perType.get(event.event_type) ?? 0
    if (count >= EVENTS_PER_SOURCE) {
      dropped += 1
      return false
    }
    perType.set(event.event_type, count + 1)
    return true
  })
  const [first, ...rest] = kept.slice(0, KEPT_EVENTS)
  if (first === undefined) return undefined
  const pausedSince = batches
    .flatMap((batch) => (batch.paused_since === undefined ? [] : [batch.paused_since]))
    .toSorted((left, right) => Date.parse(left) - Date.parse(right))[0]
  return {
    events: [first, ...rest],
    overflow: kept.slice(KEPT_EVENTS),
    omitted: batches.reduce((sum, batch) => sum + batch.omitted, 0) + dropped,
    ...(pausedSince === undefined ? {} : { paused_since: pausedSince })
  }
}

export const screenedBatch = (
  batch: EventBatch,
  passed: ReadonlySet<string>,
  keyOf: (event: BatchedEvent) => string
): EventBatch | undefined => {
  const strip = ({ run_only_if: _asked, ...event }: BatchedEvent): BatchedEvent => event
  const [head, ...tail] = batch.events.filter((event) => passed.has(keyOf(event))).map(strip)
  const { events: _judged, overflow: _stored, unchecked: _count, ...reason } = batch
  if (head !== undefined)
    return { ...reason, events: [head, ...tail], overflow: batch.overflow, omitted: batch.omitted }
  const [oldest, ...older] = batch.overflow.map(strip)
  if (oldest === undefined) return undefined
  return {
    ...reason,
    events: [oldest, ...older],
    overflow: [],
    omitted: batch.omitted,
    unchecked: batch.overflow.length
  }
}

export interface RunEvents {
  readonly run: "this_run" | "latest_in_chat"
  readonly startedAt: string
  readonly events: ReadonlyArray<BatchedEvent>
}

export interface RunEventsPage {
  readonly events: ReadonlyArray<BatchedEvent>
  readonly total: number
  readonly offset: number
  readonly nextOffset: number | undefined
  readonly types: ReadonlyArray<{ readonly eventType: string; readonly count: number }>
}

export const pageRunEvents = (
  events: ReadonlyArray<BatchedEvent>,
  options: {
    readonly offset: number
    readonly limit: number
    readonly eventType: string | undefined
  }
): RunEventsPage => {
  const matching = events
    .filter((event) => options.eventType === undefined || event.event_type === options.eventType)
    .toSorted((left, right) => Date.parse(right.queued_at) - Date.parse(left.queued_at))
  const page = matching.slice(options.offset, options.offset + options.limit)
  const end = options.offset + page.length
  const counts = new Map<string, number>()
  for (const event of events) counts.set(event.event_type, (counts.get(event.event_type) ?? 0) + 1)
  return {
    events: page,
    total: matching.length,
    offset: options.offset,
    nextOffset: end < matching.length ? end : undefined,
    types: [...counts]
      .map(([eventType, count]) => ({ eventType, count }))
      .toSorted((left, right) => right.count - left.count)
  }
}

const identityOf = (event: BatchedEvent): string => {
  const chat = event.context["chat"]
  if (
    event.event_type === "chat.quiet" &&
    Predicate.isObject(chat) &&
    !Array.isArray(chat) &&
    typeof chat["session_id"] === "string"
  )
    return `chat.quiet:${chat["session_id"]}`
  return `${event.event_type}:${event.event_key}`
}
