import {
  MESSAGE_CLOSURE,
  RUN_ACTIVITY_TARGET,
  reduceRunActivity,
  type RunActivityProjection
} from "@arden-hq/protocol/chat"
import { Buffer } from "node:buffer"
import { SERVER_EVENT_TYPE, type ChatProjectionEvent } from "@arden-hq/protocol"
import {
  isEphemeralChatEvent,
  isRunTerminalEvent,
  type EphemeralChatEventType
} from "@arden-hq/protocol/chat"
import type { SessionEventRecord } from "./model.js"

export const ACTIVE_PROJECTION = {
  ready: "ready",
  overflow: "overflow",
  terminal: "terminal"
} as const

interface ReadyActiveProjection {
  readonly activity?: RunActivityProjection
  readonly kind: typeof ACTIVE_PROJECTION.ready
  readonly runId: string | undefined
  readonly records: ReadonlyArray<RetainedActiveRecord>
  readonly bytes: number
}

type EphemeralRecord = SessionEventRecord & {
  readonly event: Extract<ChatProjectionEvent, { readonly type: EphemeralChatEventType }>
}

const isEphemeralRecord = (record: SessionEventRecord): record is EphemeralRecord =>
  isEphemeralChatEvent(record.event)

interface RetainedActiveRecord {
  readonly fromSequence: number
  readonly record: EphemeralRecord
  readonly bytes: number
  readonly deltaBytes: number
}

interface OverflowedActiveProjection {
  readonly activity?: RunActivityProjection
  readonly kind: typeof ACTIVE_PROJECTION.overflow
  readonly runId: string | undefined
  readonly throughSequence: number
  readonly transientsHeldUntilReasoningEnd?: {
    readonly records: ReadonlyArray<RetainedActiveRecord>
    readonly bytes: number
    readonly reasoningMessageIds: ReadonlySet<string>
  }
}

interface TerminalActiveProjection {
  readonly kind: typeof ACTIVE_PROJECTION.terminal
  readonly runId: string
  readonly throughSequence: number
}

export type ActiveProjectionState =
  | ReadyActiveProjection
  | OverflowedActiveProjection
  | TerminalActiveProjection

export const terminalEventRunId = (event: ChatProjectionEvent): string | undefined =>
  isRunTerminalEvent(event) ? event.run_id : undefined

export const terminalRunId = (record: SessionEventRecord): string | undefined =>
  terminalEventRunId(record.event)

const recordBytes = (record: SessionEventRecord): number =>
  Buffer.byteLength(JSON.stringify(record.event), "utf8")

const jsonStringBytes = (value: string): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8") - 2

const deltaOf = (event: EphemeralRecord["event"]): string => {
  switch (event.type) {
    case SERVER_EVENT_TYPE.textMessageContent:
    case SERVER_EVENT_TYPE.reasoningMessageContent:
    case SERVER_EVENT_TYPE.toolCallArgs:
    case SERVER_EVENT_TYPE.toolCallOutputDelta:
      return event.delta
    case SERVER_EVENT_TYPE.toolCallProgress:
    case SERVER_EVENT_TYPE.runActivity:
    case SERVER_EVENT_TYPE.streamRetry:
    case SERVER_EVENT_TYPE.inputTaken:
    case SERVER_EVENT_TYPE.tokenUsage:
      return ""
  }
}

const retain = (record: EphemeralRecord): RetainedActiveRecord => ({
  fromSequence: record.sequence,
  record,
  bytes: recordBytes(record),
  deltaBytes: jsonStringBytes(deltaOf(record.event))
})

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

const mergedBytes = (
  previous: RetainedActiveRecord,
  current: RetainedActiveRecord
): { readonly bytes: number; readonly deltaBytes: number } => {
  const previousDelta = deltaOf(previous.record.event)
  const currentDelta = deltaOf(current.record.event)
  const joined =
    previousDelta.length > 0 &&
    currentDelta.length > 0 &&
    isHighSurrogate(previousDelta.charCodeAt(previousDelta.length - 1)) &&
    isLowSurrogate(currentDelta.charCodeAt(0))
  const saved = joined ? 8 : 0
  return {
    bytes: current.bytes + previous.deltaBytes - saved,
    deltaBytes: previous.deltaBytes + current.deltaBytes - saved
  }
}

const coalescedTransient = (
  previous: RetainedActiveRecord | undefined,
  currentRetained: RetainedActiveRecord
): RetainedActiveRecord | undefined => {
  const current = currentRetained.record
  if (previous === undefined || previous.record.sequence + 1 !== current.sequence) return undefined
  const previousRecord = previous.record
  switch (current.event.type) {
    case SERVER_EVENT_TYPE.textMessageContent:
      return previousRecord.event.type === SERVER_EVENT_TYPE.textMessageContent &&
        previousRecord.event.message_id === current.event.message_id
        ? {
            fromSequence: previous.fromSequence,
            record: {
              ...current,
              event: {
                ...current.event,
                delta: previousRecord.event.delta + current.event.delta
              }
            },
            ...mergedBytes(previous, currentRetained)
          }
        : undefined
    case SERVER_EVENT_TYPE.reasoningMessageContent:
      return previousRecord.event.type === SERVER_EVENT_TYPE.reasoningMessageContent &&
        previousRecord.event.message_id === current.event.message_id
        ? {
            fromSequence: previous.fromSequence,
            record: {
              ...current,
              event: {
                ...current.event,
                delta: previousRecord.event.delta + current.event.delta
              }
            },
            ...mergedBytes(previous, currentRetained)
          }
        : undefined
    case SERVER_EVENT_TYPE.toolCallArgs:
      return previousRecord.event.type === SERVER_EVENT_TYPE.toolCallArgs &&
        previousRecord.event.tool_call_id === current.event.tool_call_id &&
        previousRecord.event.execution === current.event.execution
        ? {
            fromSequence: previous.fromSequence,
            record: {
              ...current,
              event: {
                ...current.event,
                delta: previousRecord.event.delta + current.event.delta
              }
            },
            ...mergedBytes(previous, currentRetained)
          }
        : undefined
    case SERVER_EVENT_TYPE.toolCallOutputDelta:
      return previousRecord.event.type === SERVER_EVENT_TYPE.toolCallOutputDelta &&
        previousRecord.event.tool_call_id === current.event.tool_call_id &&
        previousRecord.event.execution === current.event.execution &&
        previousRecord.event.stream === current.event.stream
        ? {
            fromSequence: previous.fromSequence,
            record: {
              ...current,
              event: {
                ...current.event,
                delta: previousRecord.event.delta + current.event.delta
              }
            },
            ...mergedBytes(previous, currentRetained)
          }
        : undefined
    case SERVER_EVENT_TYPE.toolCallProgress:
      return previousRecord.event.type === SERVER_EVENT_TYPE.toolCallProgress &&
        previousRecord.event.tool_call_id === current.event.tool_call_id &&
        previousRecord.event.execution === current.event.execution &&
        previousRecord.event.data === undefined &&
        current.event.data === undefined
        ? { ...currentRetained, fromSequence: previous.fromSequence }
        : undefined
    case SERVER_EVENT_TYPE.runActivity:
    case SERVER_EVENT_TYPE.streamRetry:
    case SERVER_EVENT_TYPE.inputTaken:
    case SERVER_EVENT_TYPE.tokenUsage:
      return undefined
  }
}

type RunActivityEvent = Extract<
  ChatProjectionEvent,
  { readonly type: typeof SERVER_EVENT_TYPE.runActivity }
>

const activityCallIds = (event: RunActivityEvent): ReadonlyArray<string> | undefined =>
  event.target.kind === RUN_ACTIVITY_TARGET.calls ? event.target.tool_call_ids : undefined

const withActivityCalls = (
  event: RunActivityEvent,
  ids: ReadonlyArray<string>
): RunActivityEvent => ({
  ...event,
  target: { kind: RUN_ACTIVITY_TARGET.calls, tool_call_ids: ids }
})

const activityCallsOf = (
  event: ChatProjectionEvent
): { readonly event: RunActivityEvent; readonly ids: ReadonlyArray<string> } | undefined => {
  if (event.type !== SERVER_EVENT_TYPE.runActivity) return undefined
  const ids = activityCallIds(event)
  return ids === undefined ? undefined : { event, ids }
}

const settledActivityIds = (event: ChatProjectionEvent): ReadonlyArray<string> | undefined => {
  if (event.type === SERVER_EVENT_TYPE.toolCallResult) return [event.tool_call_id]
  return event.type === SERVER_EVENT_TYPE.modelResponseReset
    ? event.tool_call_ids
    : activityCallsOf(event)?.ids
}

const pruneSettledTransient = (
  records: ReadonlyArray<RetainedActiveRecord>,
  record: SessionEventRecord
): ReadonlyArray<RetainedActiveRecord> => {
  const replacedIds =
    record.event.type === SERVER_EVENT_TYPE.runActivity ? activityCallIds(record.event) : undefined
  const settledIds = settledActivityIds(record.event)
  const retained = records.flatMap((candidate) => {
    const event = candidate.record.event
    if (event.type !== SERVER_EVENT_TYPE.runActivity) return [candidate]
    const calls = activityCallIds(event)
    if (calls === undefined)
      return record.event.type === SERVER_EVENT_TYPE.runActivity && replacedIds === undefined
        ? []
        : [candidate]
    if (settledIds === undefined) return [candidate]
    const ids = calls.filter((id) => !settledIds.includes(id))
    if (ids.length === 0) return []
    if (ids.length === calls.length) return [candidate]
    return [retain({ ...candidate.record, event: withActivityCalls(event, ids) })]
  })
  records = retained
  const event = record.event
  if (event.type === SERVER_EVENT_TYPE.textMessageEnd) {
    return event.closure.kind === MESSAGE_CLOSURE.abandoned
      ? records
      : records.filter(
          (candidate) =>
            candidate.record.event.type !== SERVER_EVENT_TYPE.textMessageContent ||
            candidate.record.event.message_id !== event.message_id
        )
  }
  if (event.type === SERVER_EVENT_TYPE.reasoningMessageEnd) {
    return event.closure.kind === MESSAGE_CLOSURE.abandoned
      ? records
      : records.filter(
          (candidate) =>
            candidate.record.event.type !== SERVER_EVENT_TYPE.reasoningMessageContent ||
            candidate.record.event.message_id !== event.message_id
        )
  }
  if (event.type === SERVER_EVENT_TYPE.toolCallResult) {
    return records.filter(
      (candidate) =>
        (candidate.record.event.type !== SERVER_EVENT_TYPE.toolCallOutputDelta &&
          candidate.record.event.type !== SERVER_EVENT_TYPE.toolCallProgress) ||
        candidate.record.event.tool_call_id !== event.tool_call_id
    )
  }
  if (event.type !== SERVER_EVENT_TYPE.modelResponseReset) return records
  const messageIds = new Set(event.message_ids)
  const toolCallIds = new Set(event.tool_call_ids)
  return records.filter((candidate) => {
    switch (candidate.record.event.type) {
      case SERVER_EVENT_TYPE.textMessageContent:
      case SERVER_EVENT_TYPE.reasoningMessageContent:
        return !messageIds.has(candidate.record.event.message_id)
      case SERVER_EVENT_TYPE.toolCallArgs:
      case SERVER_EVENT_TYPE.toolCallOutputDelta:
      case SERVER_EVENT_TYPE.toolCallProgress:
        return !toolCallIds.has(candidate.record.event.tool_call_id)
      case SERVER_EVENT_TYPE.runActivity:
      case SERVER_EVENT_TYPE.streamRetry:
      case SERVER_EVENT_TYPE.inputTaken:
      case SERVER_EVENT_TYPE.tokenUsage:
        return true
    }
  })
}

const totalBytes = (records: ReadonlyArray<RetainedActiveRecord>): number =>
  records.reduce((total, candidate) => total + candidate.bytes, 0)

export const projectionBytes = (projection: ActiveProjectionState | undefined): number => {
  if (projection?.kind === ACTIVE_PROJECTION.ready) return projection.bytes
  return projection?.kind === ACTIVE_PROJECTION.overflow
    ? (projection.transientsHeldUntilReasoningEnd?.bytes ?? 0)
    : 0
}

const recoverOverflow = (
  current: OverflowedActiveProjection,
  record: SessionEventRecord
): ActiveProjectionState => {
  const held = current.transientsHeldUntilReasoningEnd
  if (held === undefined) {
    return { ...current, throughSequence: Math.max(current.throughSequence, record.sequence) }
  }
  if (record.event.type === SERVER_EVENT_TYPE.reasoningMessageContent) {
    return held.reasoningMessageIds.has(record.event.message_id)
      ? { ...current, throughSequence: Math.max(current.throughSequence, record.sequence) }
      : {
          kind: ACTIVE_PROJECTION.overflow,
          runId: current.runId,
          throughSequence: Math.max(current.throughSequence, record.sequence)
        }
  }
  if (isEphemeralChatEvent(record.event)) {
    return {
      kind: ACTIVE_PROJECTION.overflow,
      runId: current.runId,
      throughSequence: Math.max(current.throughSequence, record.sequence)
    }
  }

  const records = pruneSettledTransient(held.records, record)
  const bytes = records === held.records ? held.bytes : totalBytes(records)
  const reasoningMessageIds = new Set(held.reasoningMessageIds)
  if (
    record.event.type === SERVER_EVENT_TYPE.reasoningMessageEnd &&
    record.event.closure.kind === MESSAGE_CLOSURE.complete
  ) {
    reasoningMessageIds.delete(record.event.message_id)
  } else if (record.event.type === SERVER_EVENT_TYPE.modelResponseReset) {
    for (const messageId of record.event.message_ids) reasoningMessageIds.delete(messageId)
  }
  return reasoningMessageIds.size === 0
    ? { kind: ACTIVE_PROJECTION.ready, runId: current.runId, records, bytes }
    : {
        ...current,
        throughSequence: Math.max(current.throughSequence, record.sequence),
        transientsHeldUntilReasoningEnd: { records, bytes, reasoningMessageIds }
      }
}

const reduceProjection = (
  current: ActiveProjectionState | undefined,
  record: SessionEventRecord,
  capacityBytes: number,
  terminalCheckpointSequence: number | undefined,
  allowCoalescing: boolean
): ActiveProjectionState | undefined => {
  if (record.event.type === SERVER_EVENT_TYPE.runStarted) {
    if (current?.kind === ACTIVE_PROJECTION.terminal && current.runId === record.event.run_id)
      return current
    return { kind: ACTIVE_PROJECTION.ready, runId: record.event.run_id, records: [], bytes: 0 }
  }
  if (current?.kind === ACTIVE_PROJECTION.terminal) return current

  const endedRunId = terminalRunId(record)
  if (
    endedRunId !== undefined &&
    terminalCheckpointSequence !== undefined &&
    terminalCheckpointSequence >= record.sequence &&
    (current?.runId === undefined || current.runId === endedRunId)
  ) {
    return {
      kind: ACTIVE_PROJECTION.terminal,
      runId: endedRunId,
      throughSequence: record.sequence
    }
  }
  if (current?.kind === ACTIVE_PROJECTION.overflow) {
    return recoverOverflow(current, record)
  }

  if (!isEphemeralRecord(record)) {
    if (current === undefined) return undefined
    const records = pruneSettledTransient(current.records, record)
    return records === current.records
      ? current
      : {
          ...current,
          records,
          bytes: totalBytes(records)
        }
  }

  const ready = current ?? {
    kind: ACTIVE_PROJECTION.ready,
    runId: record.runId ?? undefined,
    records: [],
    bytes: 0
  }
  if (
    ready.runId !== undefined &&
    record.runId !== undefined &&
    record.runId !== null &&
    ready.runId !== record.runId
  ) {
    return ready
  }
  const retainedRecords = pruneSettledTransient(ready.records, record)
  const retainedBytes =
    retainedRecords === ready.records ? ready.bytes : totalBytes(retainedRecords)
  const previous = retainedRecords.at(-1)
  const retained = retain(record)
  const coalesced = allowCoalescing ? coalescedTransient(previous, retained) : undefined
  const records =
    coalesced === undefined
      ? [...retainedRecords, retained]
      : [...retainedRecords.slice(0, -1), coalesced]
  const bytes =
    coalesced === undefined
      ? retainedBytes + retained.bytes
      : retainedBytes - (previous === undefined ? 0 : previous.bytes) + coalesced.bytes
  if (bytes <= capacityBytes) return { ...ready, records, bytes }
  if (record.event.type !== SERVER_EVENT_TYPE.reasoningMessageContent) {
    return {
      kind: ACTIVE_PROJECTION.overflow,
      runId: ready.runId,
      throughSequence: record.sequence
    }
  }
  const kept = records.filter(
    (candidate) =>
      candidate.record.event.type !== SERVER_EVENT_TYPE.reasoningMessageContent ||
      candidate.record.event.message_id !== record.event.message_id
  )
  const keptBytes = totalBytes(kept)
  return {
    kind: ACTIVE_PROJECTION.overflow,
    runId: ready.runId,
    throughSequence: record.sequence,
    ...(keptBytes > capacityBytes
      ? {}
      : {
          transientsHeldUntilReasoningEnd: {
            records: kept,
            bytes: keptBytes,
            reasoningMessageIds: new Set([record.event.message_id])
          }
        })
  }
}

export const reduceActiveProjection = (
  current: ActiveProjectionState | undefined,
  record: SessionEventRecord,
  capacityBytes: number,
  terminalCheckpointSequence: number | undefined,
  allowCoalescing: boolean
): ActiveProjectionState | undefined => {
  if (record.event.type === SERVER_EVENT_TYPE.runActivity && record.event.run_id !== current?.runId)
    return current
  const recordCalls = activityCallsOf(record.event)
  if (recordCalls !== undefined) {
    const activeIds = new Set(
      current?.kind === ACTIVE_PROJECTION.terminal
        ? []
        : current?.activity?.operations.map((operation) => operation.id)
    )
    const ids = recordCalls.ids.filter((id) => activeIds.has(id))
    if (ids.length === 0) return current
    record = { ...record, event: withActivityCalls(recordCalls.event, ids) }
  }
  if (current?.kind === ACTIVE_PROJECTION.terminal && record.sequence <= current.throughSequence)
    return current
  if (
    current?.kind !== ACTIVE_PROJECTION.terminal &&
    current?.activity !== undefined &&
    record.sequence <= current.activity.sequence
  )
    return current
  const next = reduceProjection(
    current,
    record,
    capacityBytes,
    terminalCheckpointSequence,
    allowCoalescing
  )
  if (next === undefined || next.kind === ACTIVE_PROJECTION.terminal) return next
  const previous = current?.kind === ACTIVE_PROJECTION.terminal ? undefined : current?.activity
  const seed =
    previous ??
    (next.runId === undefined
      ? undefined
      : { runId: next.runId, sequence: 0, purpose: null, operations: [] })
  const activity = reduceRunActivity(seed, {
    event: record.event,
    sequence: record.sequence,
    fromOtherRun:
      seed !== undefined &&
      record.runId !== undefined &&
      record.runId !== null &&
      record.runId !== seed.runId
  })
  return activity === undefined ? next : { ...next, activity }
}
