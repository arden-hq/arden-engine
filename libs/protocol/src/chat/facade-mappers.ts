import type { Schema } from "effect"
import { HISTORY_WINDOW } from "./contracts.js"
import type {
  ActiveRunSummary,
  HistoryWindow,
  TurnWorkWindow,
  CancelResponse,
  ChatAcknowledgement,
  ChatReceipt,
  QueuedCancelResponse,
  ReadResponse,
  RunsStatus
} from "./contracts.js"
import type {
  ActiveRunSummarySchema,
  CancelResponseSchema,
  ChatAcknowledgementSchema,
  ChatReceiptResponseSchema,
  QueuedCancelResponseSchema,
  RunsStatusSchema
} from "./facade-schema.js"
import type { MarkSessionReadResponseSchema } from "./schema.js"

type ChatReceiptWire = Schema.Schema.Type<typeof ChatReceiptResponseSchema>
type CancelResponseWire = Schema.Schema.Type<typeof CancelResponseSchema>
type QueuedCancelResponseWire = Schema.Schema.Type<typeof QueuedCancelResponseSchema>
type ChatAcknowledgementWire = Schema.Schema.Type<typeof ChatAcknowledgementSchema>
type ReadResponseWire = Schema.Schema.Type<typeof MarkSessionReadResponseSchema>
type ActiveRunSummaryWire = Schema.Schema.Type<typeof ActiveRunSummarySchema>
type RunsStatusWire = Schema.Schema.Type<typeof RunsStatusSchema>

const mapActiveRunSummary = (run: ActiveRunSummaryWire): ActiveRunSummary => {
  const {
    run_id,
    turn_id,
    session_id,
    status,
    created_at,
    updated_at,
    age_seconds,
    idle_seconds,
    message_count,
    pending_injections,
    approvals_pending,
    runId: _runId,
    turnId: _turnId,
    sessionId: _sessionId,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ageSeconds: _ageSeconds,
    idleSeconds: _idleSeconds,
    messageCount: _messageCount,
    pendingInjections: _pendingInjections,
    approvalsPending: _approvalsPending,
    ...extras
  } = run
  return {
    ...extras,
    runId: run_id,
    turnId: turn_id,
    sessionId: session_id,
    status,
    createdAt: created_at,
    updatedAt: updated_at,
    ageSeconds: age_seconds,
    idleSeconds: idle_seconds,
    messageCount: message_count,
    pendingInjections: pending_injections,
    approvalsPending: approvals_pending
  }
}

export const mapRunsStatus = (response: RunsStatusWire): RunsStatus => {
  const {
    observed_at,
    total_retained,
    active_runs,
    observedAt: _observedAt,
    totalRetained: _totalRetained,
    activeRuns: _activeRuns,
    ...extras
  } = response
  return {
    ...extras,
    observedAt: observed_at,
    totalRetained: total_retained,
    activeRuns: active_runs.map(mapActiveRunSummary)
  }
}

export const mapChatReceipt = (receipt: ChatReceiptWire): ChatReceipt => {
  const {
    run_id,
    session_id,
    status,
    client_id,
    runId: _runId,
    sessionId: _sessionId,
    clientId: _clientId,
    ...extras
  } = receipt
  return {
    ...extras,
    runId: run_id,
    sessionId: session_id,
    status,
    ...(client_id === undefined ? {} : { clientId: client_id })
  }
}

export const mapCancelResponse = (response: CancelResponseWire): CancelResponse => {
  const {
    run_id,
    cancel_requested,
    status,
    runId: _runId,
    cancelRequested: _cancelRequested,
    found: _found,
    ...extras
  } = response
  return { ...extras, status, runId: run_id, cancelRequested: cancel_requested }
}

export const mapQueuedCancelResponse = (
  response: QueuedCancelResponseWire
): QueuedCancelResponse => {
  const { client_id, status, clientId: _clientId, ...extras } = response
  return { ...extras, status, clientId: client_id }
}

export const mapChatAcknowledgement = (response: ChatAcknowledgementWire): ChatAcknowledgement => {
  const { status, ...extras } = response
  return { ...extras, status }
}

export const mapReadResponse = (response: ReadResponseWire): ReadResponse => {
  const {
    session_id,
    has_unread,
    sessionId: _sessionId,
    hasUnread: _hasUnread,
    ...extras
  } = response
  return {
    ...extras,
    sessionId: session_id,
    hasUnread: has_unread
  }
}

type TurnWorkWindowQuery =
  | { readonly window: typeof HISTORY_WINDOW.latest }
  | {
      readonly window: typeof HISTORY_WINDOW.before | typeof HISTORY_WINDOW.after
      readonly cursor: string
    }

type HistoryWindowQuery =
  | TurnWorkWindowQuery
  | { readonly window: typeof HISTORY_WINDOW.around; readonly cursor: string }
  | { readonly window: typeof HISTORY_WINDOW.aroundSeq; readonly seq: number }

export const turnWorkWindow = (query: TurnWorkWindowQuery): TurnWorkWindow =>
  query.window === HISTORY_WINDOW.latest
    ? { kind: HISTORY_WINDOW.latest }
    : { kind: query.window, cursor: query.cursor }

export const historyWindow = (query: HistoryWindowQuery): HistoryWindow => {
  switch (query.window) {
    case HISTORY_WINDOW.around:
      return { kind: HISTORY_WINDOW.around, cursor: query.cursor }
    case HISTORY_WINDOW.aroundSeq:
      return { kind: HISTORY_WINDOW.aroundSeq, seq: query.seq }
    case HISTORY_WINDOW.latest:
    case HISTORY_WINDOW.before:
    case HISTORY_WINDOW.after:
      return turnWorkWindow(query)
  }
}
