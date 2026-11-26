import { pageBounds, RUNTIME_RUN } from "@arden-hq/protocol/chat"
import { parseJsonTextOrUndefined } from "@arden-hq/protocol/common"
import { ROLE } from "@arden-hq/std/message-vocabulary"
import { cutText } from "@arden-hq/std/text"
import { TRANSCRIPT_RESULT_PREVIEW_CHARS } from "../persistence/transcript/model.js"
import {
  TOOL_CALL_RESULT,
  TOOL_DISPLAY_TITLE_ARGUMENT,
  type HistoryResponse,
  type TurnWorkResponse
} from "@arden-hq/protocol/chat"
import { DateTime, Effect, Predicate } from "effect"
import type { ChatRunRecord } from "../persistence/runs/model.js"
import type { TranscriptMessageRecord, TranscriptPage } from "../persistence/transcript/model.js"
import type {
  AgentAssignment,
  ToolExecutionResultMetadata
} from "../persistence/tools/history-queries.js"
import { ChatHistoryError } from "./history-errors.js"
import { historyToolCalls } from "./history-tool-calls.js"
import { conversationCall, type Surface } from "./surface.js"
import { contentText, projectMessage, type ChatHandoffSource } from "./history-rows.js"
export { contentText } from "./history-rows.js"
import { isActiveRunStatus } from "@arden-hq/protocol/runs"

export const historyPage = (page: TranscriptPage): HistoryResponse["page"] => ({
  has_more_before: page.hasMoreBefore,
  has_more_after: page.hasMoreAfter,
  bounds: pageBounds(page.records[0]?.messageId, page.records.at(-1)?.messageId)
})

export const activeRunSnapshot = (
  run: ChatRunRecord | null,
  latestEventSequence: number,
  checkpointSequence: number,
  pendingApprovals: HistoryResponse["runtime"]["pending_approvals"],
  pendingConnections: HistoryResponse["runtime"]["pending_connections"],
  waitingToolCallIds: ReadonlyArray<string>
): HistoryResponse["runtime"]["active_run"] => {
  if (run === null || !isActiveRunStatus(run.status)) return { kind: RUNTIME_RUN.idle }
  return {
    kind: RUNTIME_RUN.active,
    run: {
      run_id: run.runId,
      turn_id: run.turnId,
      status: run.status,
      started_at: DateTime.formatIso(run.startedAt),
      updated_at: DateTime.formatIso(run.updatedAt),
      ended_at: null,
      stop_reason: null,
      checkpoint_seq: checkpointSequence,
      latest_event_seq: run.lastSequence ?? latestEventSequence,
      error_code: null,
      error_message: null,
      pending_approvals: pendingApprovals.filter((approval) => approval.run_id === run.runId),
      pending_connections: pendingConnections.filter(
        (connection) => connection.run_id === run.runId
      ),
      waiting_tool_call_ids: [...waitingToolCallIds]
    }
  }
}

export type StampedTranscriptMessageRecord = TranscriptMessageRecord & {
  readonly envelope: TranscriptMessageRecord["envelope"] & { readonly turn_id: string }
}

const hasTurnStamp = (record: TranscriptMessageRecord): record is StampedTranscriptMessageRecord =>
  Predicate.isString(record.envelope.turn_id) && record.envelope.turn_id.length > 0

export const requireTurnStamps = Effect.fn("ChatHistory.requireTurnStamps")(function* (
  records: ReadonlyArray<TranscriptMessageRecord>,
  sessionId: string
): Effect.fn.Return<ReadonlyArray<StampedTranscriptMessageRecord>, ChatHistoryError> {
  const stamped = records.filter(hasTurnStamp)
  if (stamped.length !== records.length) {
    return yield* new ChatHistoryError({
      message: `Transcript rows for ${sessionId} are missing durable turn identity`
    })
  }
  return stamped
})

export const pinnedConversationCalls = (
  records: ReadonlyArray<StampedTranscriptMessageRecord>
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const pinnedByTurn = new Map<string, Array<string>>()
  for (const record of records) {
    if (record.role !== ROLE.assistant) continue
    const ids = historyToolCalls(record.envelope.tool_calls)
      .filter(conversationCall)
      .map((call) => call.id)
    if (ids.length === 0) continue
    pinnedByTurn.set(record.envelope.turn_id, [
      ...(pinnedByTurn.get(record.envelope.turn_id) ?? []),
      ...ids
    ])
  }
  return pinnedByTurn
}

export const toolResultTexts = (
  results: ReadonlyArray<TranscriptMessageRecord>
): ReadonlyMap<string, string> => {
  const texts = new Map<string, string>()
  for (const result of results) {
    const toolCallId = result.envelope.tool_call_id
    if (Predicate.isString(toolCallId)) texts.set(toolCallId, contentText(result.envelope.content))
  }
  return texts
}

export const isConversationRecord = (record: TranscriptMessageRecord): boolean =>
  record.role !== ROLE.system &&
  record.role !== ROLE.developer &&
  !isSessionHandoff(record.envelope) &&
  typeof record.envelope.forked_from !== "string"

export const mergeTurnWorkRecords = (
  carriers: ReadonlyArray<StampedTranscriptMessageRecord>,
  results: ReadonlyArray<StampedTranscriptMessageRecord>
): ReadonlyArray<StampedTranscriptMessageRecord> => {
  const byId = new Map<string, StampedTranscriptMessageRecord>()
  for (const record of [...carriers, ...results]) byId.set(record.messageId, record)
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence)
}

const COMPACT_TEXT_CHARS = TRANSCRIPT_RESULT_PREVIEW_CHARS

const compactText = (text: string): string => cutText(text, COMPACT_TEXT_CHARS)

const compactArguments = (raw: string): { readonly text: string; readonly changed: boolean } => {
  const parsed = parseJsonTextOrUndefined(raw)
  if (!Predicate.isObject(parsed) || Array.isArray(parsed)) {
    return raw.length <= COMPACT_TEXT_CHARS
      ? { text: raw, changed: false }
      : { text: compactText(raw), changed: true }
  }
  let changed = false
  const compact: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (Predicate.isString(value)) {
      if (key === TOOL_DISPLAY_TITLE_ARGUMENT || value.length <= COMPACT_TEXT_CHARS)
        compact[key] = value
      else {
        compact[key] = compactText(value)
        changed = true
      }
    } else if (value === null || Predicate.isNumber(value) || Predicate.isBoolean(value)) {
      compact[key] = value
    } else {
      const json = JSON.stringify(value)
      if (json.length <= COMPACT_TEXT_CHARS) compact[key] = value
      else changed = true
    }
  }
  return { text: changed ? JSON.stringify(compact) : raw, changed }
}

export const compactTurnWork = (response: TurnWorkResponse): TurnWorkResponse => ({
  ...response,
  messages: response.messages.map((message) => {
    if (message.role === ROLE.tool) {
      const content = compactText(message.content)
      return content === message.content ? message : { ...message, content, compact: true }
    }
    if (message.role !== ROLE.assistant) return message
    let changed = false
    const toolCalls = message.tool_calls.map((call) => {
      const compacted = compactArguments(call.arguments)
      const result =
        call.result.kind === TOOL_CALL_RESULT.shown
          ? { ...call.result, text: compactText(call.result.text) }
          : call.result
      if (!compacted.changed && result === call.result) return call
      changed = true
      return { ...call, arguments: compacted.text, result }
    })
    return changed ? { ...message, tool_calls: toolCalls, compact: true } : message
  })
})

export interface MessageSources {
  readonly pinnedResults: ReadonlyMap<string, string>
  readonly parentSource: ChatHandoffSource | undefined
  readonly assignment: AgentAssignment | undefined
}

export const workSources = (parentSource: ChatHandoffSource | undefined): MessageSources => ({
  pinnedResults: new Map(),
  parentSource,
  assignment: undefined
})

export const projectMessages = Effect.fn("ChatHistory.projectMessages")(function* (
  records: ReadonlyArray<StampedTranscriptMessageRecord>,
  resultMetadata: ReadonlyMap<string, ToolExecutionResultMetadata>,
  surface: Surface,
  options: MessageSources
): Effect.fn.Return<HistoryResponse["messages"], never> {
  const messages: Array<HistoryResponse["messages"][number]> = []
  for (const record of records) {
    const projected = projectMessage(
      record,
      resultMetadata,
      surface,
      options.pinnedResults,
      options.parentSource,
      options.assignment
    )
    if (projected === null) continue
    for (const warning of projected.warnings) {
      yield* Effect.logWarning(warning, {
        sessionId: record.sessionId,
        messageId: record.messageId,
        surface
      })
    }
    messages.push(projected.message)
  }
  return messages
})

const storedToolCallIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter(Predicate.isObject)
        .flatMap((call) => (Predicate.isString(call.id) ? [call.id] : []))
    : []

export const historyToolCallIds = (records: ReadonlyArray<TranscriptMessageRecord>): string[] => [
  ...new Set(
    records.flatMap((record) => [
      ...storedToolCallIds(record.envelope.provider_tool_calls),
      ...storedToolCallIds(record.envelope.tool_calls),
      ...(record.role === ROLE.tool && Predicate.isString(record.envelope.tool_call_id)
        ? [record.envelope.tool_call_id]
        : [])
    ])
  )
]

const isSessionHandoff = (envelope: Readonly<Record<string, unknown>>): boolean => {
  const receipt = envelope.compaction
  return Predicate.isObject(receipt) && receipt.kind === "session_handoff"
}
