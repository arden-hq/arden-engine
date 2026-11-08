import { reduceRunActivity, type RunActivityProjection } from "@arden-hq/protocol/chat"
import { Buffer } from "node:buffer"
import type { ChatProjectionEvent } from "@arden-hq/protocol"
import {
  isEphemeralChatEvent,
  isRunTerminalEvent,
  type EphemeralChatEventType
} from "@arden-hq/protocol/chat"
import type { SessionEventRecord } from "./model.js"

interface ReadyActiveProjection {
  readonly activity?: RunActivityProjection
  readonly kind: "ready"
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
  readonly kind: "overflow"
  readonly runId: string | undefined
  readonly throughSequence: number
  readonly transientsHeldUntilReasoningEnd?: {
    readonly records: ReadonlyArray<RetainedActiveRecord>
    readonly bytes: number
    readonly reasoningMessageIds: ReadonlySet<string>
  }
}

interface TerminalActiveProjection {
  readonly kind: "terminal"
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
    case "TEXT_MESSAGE_CONTENT":
    case "REASONING_MESSAGE_CONTENT":
    case "TOOL_CALL_ARGS":
    case "TOOL_CALL_OUTPUT_DELTA":
      return event.delta
    case "TOOL_CALL_PROGRESS":
    case "run_activity":
    case "stream_retry":
    case "input_taken":
    case "token_usage":
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

/**
 * Bytes of the event with `previous.delta + current.delta`, without
 * re-serializing the accumulated delta. JSON escapes a lone surrogate to six
 * bytes, so a pair split across the two deltas shrinks to four once joined.
 */
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
    case "TEXT_MESSAGE_CONTENT":
      return previousRecord.event.type === "TEXT_MESSAGE_CONTENT" &&
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
    case "REASONING_MESSAGE_CONTENT":
      return previousRecord.event.type === "REASONING_MESSAGE_CONTENT" &&
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
    case "TOOL_CALL_ARGS":
      return previousRecord.event.type === "TOOL_CALL_ARGS" &&
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
    case "TOOL_CALL_OUTPUT_DELTA":
      return previousRecord.event.type === "TOOL_CALL_OUTPUT_DELTA" &&
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
    case "TOOL_CALL_PROGRESS":
      return previousRecord.event.type === "TOOL_CALL_PROGRESS" &&
        previousRecord.event.tool_call_id === current.event.tool_call_id &&
        previousRecord.event.execution === current.event.execution &&
        previousRecord.event.data === undefined &&
        current.event.data === undefined
        ? { ...currentRetained, fromSequence: previous.fromSequence }
        : undefined
    case "run_activity":
    case "stream_retry":
    case "input_taken":
    case "token_usage":
      return undefined
  }
}

const settledActivityIds = (event: ChatProjectionEvent): ReadonlyArray<string> | undefined => {
  if (event.type === "TOOL_CALL_RESULT") return [event.tool_call_id]
  return event.type === "model_response_reset" || event.type === "run_activity"
    ? event.tool_call_ids
    : undefined
}

const pruneSettledTransient = (
  records: ReadonlyArray<RetainedActiveRecord>,
  record: SessionEventRecord
): ReadonlyArray<RetainedActiveRecord> => {
  const replacedIds = record.event.type === "run_activity" ? record.event.tool_call_ids : undefined
  const settledIds = settledActivityIds(record.event)
  const retained = records.flatMap((candidate) => {
    const event = candidate.record.event
    if (event.type !== "run_activity") return [candidate]
    if (event.tool_call_ids === undefined)
      return record.event.type === "run_activity" && replacedIds === undefined ? [] : [candidate]
    if (settledIds === undefined) return [candidate]
    const ids = event.tool_call_ids.filter((id) => !settledIds.includes(id))
    if (ids.length === 0) return []
    if (ids.length === event.tool_call_ids.length) return [candidate]
    return [retain({ ...candidate.record, event: { ...event, tool_call_ids: ids } })]
  })
  records = retained
  const event = record.event
  if (event.type === "TEXT_MESSAGE_END") {
    return event.content === undefined
      ? records
      : records.filter(
          (candidate) =>
            candidate.record.event.type !== "TEXT_MESSAGE_CONTENT" ||
            candidate.record.event.message_id !== event.message_id
        )
  }
  if (event.type === "REASONING_MESSAGE_END") {
    return event.content === undefined
      ? records
      : records.filter(
          (candidate) =>
            candidate.record.event.type !== "REASONING_MESSAGE_CONTENT" ||
            candidate.record.event.message_id !== event.message_id
        )
  }
  if (event.type === "TOOL_CALL_RESULT") {
    return records.filter(
      (candidate) =>
        (candidate.record.event.type !== "TOOL_CALL_OUTPUT_DELTA" &&
          candidate.record.event.type !== "TOOL_CALL_PROGRESS") ||
        candidate.record.event.tool_call_id !== event.tool_call_id
    )
  }
  if (event.type !== "model_response_reset") return records
  const messageIds = new Set(event.message_ids)
  const toolCallIds = new Set(event.tool_call_ids)
  return records.filter((candidate) => {
    switch (candidate.record.event.type) {
      case "TEXT_MESSAGE_CONTENT":
      case "REASONING_MESSAGE_CONTENT":
        return !messageIds.has(candidate.record.event.message_id)
      case "TOOL_CALL_ARGS":
      case "TOOL_CALL_OUTPUT_DELTA":
      case "TOOL_CALL_PROGRESS":
        return !toolCallIds.has(candidate.record.event.tool_call_id)
      case "run_activity":
      case "stream_retry":
      case "input_taken":
      case "token_usage":
        return true
    }
  })
}

const totalBytes = (records: ReadonlyArray<RetainedActiveRecord>): number =>
  records.reduce((total, candidate) => total + candidate.bytes, 0)

export const projectionBytes = (projection: ActiveProjectionState | undefined): number => {
  if (projection?.kind === "ready") return projection.bytes
  return projection?.kind === "overflow"
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
  if (record.event.type === "REASONING_MESSAGE_CONTENT") {
    return held.reasoningMessageIds.has(record.event.message_id)
      ? { ...current, throughSequence: Math.max(current.throughSequence, record.sequence) }
      : {
          kind: "overflow",
          runId: current.runId,
          throughSequence: Math.max(current.throughSequence, record.sequence)
        }
  }
  if (isEphemeralChatEvent(record.event)) {
    return {
      kind: "overflow",
      runId: current.runId,
      throughSequence: Math.max(current.throughSequence, record.sequence)
    }
  }

  const records = pruneSettledTransient(held.records, record)
  const bytes = records === held.records ? held.bytes : totalBytes(records)
  const reasoningMessageIds = new Set(held.reasoningMessageIds)
  if (record.event.type === "REASONING_MESSAGE_END" && record.event.content !== undefined) {
    reasoningMessageIds.delete(record.event.message_id)
  } else if (record.event.type === "model_response_reset") {
    for (const messageId of record.event.message_ids) reasoningMessageIds.delete(messageId)
  }
  return reasoningMessageIds.size === 0
    ? { kind: "ready", runId: current.runId, records, bytes }
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
  if (record.event.type === "RUN_STARTED") {
    if (current?.kind === "terminal" && current.runId === record.event.run_id) return current
    return { kind: "ready", runId: record.event.run_id, records: [], bytes: 0 }
  }
  if (current?.kind === "terminal") return current

  const endedRunId = terminalRunId(record)
  if (
    endedRunId !== undefined &&
    terminalCheckpointSequence !== undefined &&
    terminalCheckpointSequence >= record.sequence &&
    (current?.runId === undefined || current.runId === endedRunId)
  ) {
    return {
      kind: "terminal",
      runId: endedRunId,
      throughSequence: record.sequence
    }
  }
  if (current?.kind === "overflow") {
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
    kind: "ready" as const,
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
  if (record.event.type !== "REASONING_MESSAGE_CONTENT") {
    return { kind: "overflow", runId: ready.runId, throughSequence: record.sequence }
  }
  const kept = records.filter(
    (candidate) =>
      candidate.record.event.type !== "REASONING_MESSAGE_CONTENT" ||
      candidate.record.event.message_id !== record.event.message_id
  )
  const keptBytes = totalBytes(kept)
  return {
    kind: "overflow",
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
  if (record.event.type === "run_activity" && record.event.run_id !== current?.runId) return current
  if (record.event.type === "run_activity" && record.event.tool_call_ids !== undefined) {
    const activeIds = new Set(
      current?.kind === "terminal"
        ? []
        : current?.activity?.operations.map((operation) => operation.id)
    )
    const ids = record.event.tool_call_ids.filter((id) => activeIds.has(id))
    if (ids.length === 0) return current
    record = { ...record, event: { ...record.event, tool_call_ids: ids } }
  }
  if (current?.kind === "terminal" && record.sequence <= current.throughSequence) return current
  if (
    current?.kind !== "terminal" &&
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
  if (next === undefined || next.kind === "terminal") return next
  const previous = current?.kind === "terminal" ? undefined : current?.activity
  const seed =
    previous ??
    (next.runId === undefined
      ? undefined
      : { runId: next.runId, sequence: 0, purpose: null, operations: [] })
  const activity = reduceRunActivity(seed, record)
  return activity === undefined ? next : { ...next, activity }
}
