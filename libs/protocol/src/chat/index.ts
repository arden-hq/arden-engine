import { ChangeEvidenceSchema } from "./change-evidence.js"
export type { ChangeEvidence, ChangeEntry } from "./change-evidence.js"
import {
  decoderFor,
  makeEncoder,
  projectedDecoderFor,
  runBoundary,
  strict
} from "../common/boundary.js"
import { decodeServerEventStream, decodeServerEventStreamBuffer } from "../transport/sse.js"
import type {
  CancelInput,
  ChatMessageInput,
  ConnectionResultInput,
  EnqueueChatMessageInput,
  ReorderChatQueueInput,
  HistoryRouteOptions,
  PreparedChatMessage,
  QueuedMessageAddress,
  ReadAddress,
  ToolResultInput,
  ToolCallRouteOptions,
  ToolResultValueRouteOptions,
  TurnDetailsRouteOptions,
  TurnWorkRouteOptions
} from "./contracts.js"
import {
  HistoryResponseSchema,
  TurnWorkResponseSchema,
  TurnDetailsResponseSchema,
  ToolCallResponseSchema,
  ToolResultValueResponseSchema,
  MarkSessionReadResponseSchema
} from "./schema.js"
import {
  CancelResponseSchema,
  mapCancelResponse,
  ChatAcknowledgementSchema,
  mapChatAcknowledgement,
  ChatReceiptResponseSchema,
  ConnectionResumeResponseSchema,
  mapChatReceipt,
  encodeToolCallPathEffect,
  encodeToolResultValuePathEffect,
  QueuedCancelResponseSchema,
  mapQueuedCancelResponse,
  QueuedChatMessageSchema,
  QueuedChatMessagesSchema,
  mapReadResponse,
  RunsStatusSchema,
  mapRunsStatus,
  encodeCancelRequestEffect,
  encodeChatMessageRequestEffect,
  encodeConnectionResultRequestEffect,
  encodeEnqueueChatMessageRequestEffect,
  encodeReorderChatQueueRequestEffect,
  encodeEventPathEffect,
  encodeHistoryPathEffect,
  encodeTurnWorkPathEffect,
  encodeTurnDetailsPathEffect,
  encodeQueuePathEffect,
  encodeQueuedMessagePathEffect,
  encodeReadPathEffect,
  encodeToolResultRequestEffect
} from "./facade-schema.js"
import {
  PersistedChildAgentMetadataSchema,
  ToolResultCostSchema,
  ToolResultUsageSchema
} from "./child-agent.js"
import { CommunicationEnvelopeSchema } from "./communication-schema.js"
import { ServerEventSchema } from "../events/schema.js"
import { GmailSendReceiptSchema } from "./gmail-receipt.js"

export * from "./contracts.js"
export type { ToolResultValueResponse } from "./schema.js"
export * from "./runtime.js"
export {
  reduceRunActivity,
  runActivityView,
  runActivityProjection,
  type RunActivity,
  type RunActivityProjection
} from "./activity.js"
export type * from "./communication.js"
export { answeredInTurn } from "./answered-in-turn.js"
export {
  markdownLines,
  markdownWords,
  previewLine,
  previewMarkup,
  splitLeadingJson
} from "./preview-line.js"
export { stripCitationMarkers } from "./citation-markers.js"
export {
  answerBlockBodies,
  answerBlockFences,
  answerBlockLabel,
  answerBlockTitle,
  replaceAnswerBlocks,
  type AnswerBlockFence
} from "./answer-blocks.js"
export {
  attachedFileNames,
  splitAttachedFiles,
  withAttachedFiles,
  withFileNames,
  type AttachedFileRef,
  type SplitAttachedFiles
} from "./attached-files.js"
export {
  failureSentence,
  inTaskWords,
  isRequestInvalid,
  providerSentence,
  runFailureText,
  type RunFailureText
} from "./run-failure.js"
export { RESTART_INTERRUPTION } from "./restart-words.js"
export { MAX_TOOL_DISPLAY_TITLE_LENGTH, TOOL_DISPLAY_TITLE_ARGUMENT } from "./tool-display.js"
export {
  APPROVAL_PRESENTATION_LIMITS,
  sanitizeApprovalPresentation
} from "./approval-presentation.js"
export type {
  ApprovalPresentation,
  ApprovalPresentationBody,
  ApprovalPresentationField
} from "./approval-presentation.js"
export type { CapabilityCandidate, CapabilityProposal } from "./capability-proposal.js"
export type { ChatRunErrorCode, RunTerminalEvent, TransientRunErrorCode } from "./events/run.js"
export { isLastingRunError, TRANSIENT_RUN_ERROR_CODES } from "./events/run.js"
export { endsReadingMessage, isRunTerminalEvent } from "./events/run.js"

/** Plain response decoders for the current Chat boundary. */
export const chatDecoders = {
  changeEvidence: decoderFor(ChangeEvidenceSchema, "Invalid change evidence", strict),
  receipt: projectedDecoderFor(ChatReceiptResponseSchema, mapChatReceipt, "Invalid chat receipt"),
  acknowledgement: projectedDecoderFor(
    ChatAcknowledgementSchema,
    mapChatAcknowledgement,
    "Invalid chat acknowledgement"
  ),
  connectionResume: decoderFor(
    ConnectionResumeResponseSchema,
    "Invalid connection-resume response"
  ),
  cancel: projectedDecoderFor(CancelResponseSchema, mapCancelResponse, "Invalid chat cancellation"),
  queuedCancellation: projectedDecoderFor(
    QueuedCancelResponseSchema,
    mapQueuedCancelResponse,
    "Invalid queued-message cancellation"
  ),
  queue: decoderFor(QueuedChatMessagesSchema, "Invalid queued-message list"),
  queuedMessage: decoderFor(QueuedChatMessageSchema, "Invalid queued message"),
  history: decoderFor(HistoryResponseSchema, "Invalid session history"),
  turnWork: decoderFor(TurnWorkResponseSchema, "Invalid turn work"),
  turnDetails: decoderFor(TurnDetailsResponseSchema, "Invalid turn details"),
  toolCall: decoderFor(ToolCallResponseSchema, "Invalid tool call", strict),
  toolResultValue: decoderFor(ToolResultValueResponseSchema, "Invalid tool-result value"),
  read: projectedDecoderFor(
    MarkSessionReadResponseSchema,
    mapReadResponse,
    "Invalid session-read response"
  ),
  runsStatus: projectedDecoderFor(RunsStatusSchema, mapRunsStatus, "Invalid active-run status"),
  event: decoderFor(ServerEventSchema, "Invalid server event"),
  eventStream: decodeServerEventStream,
  eventStreamBuffer: decodeServerEventStreamBuffer,
  childAgentMetadata: decoderFor(
    PersistedChildAgentMetadataSchema,
    "Invalid child-agent metadata",
    strict
  ),
  toolResultUsage: decoderFor(ToolResultUsageSchema, "Invalid tool-result usage"),
  toolResultCost: decoderFor(ToolResultCostSchema, "Invalid tool-result cost"),
  communication: decoderFor(CommunicationEnvelopeSchema, "Invalid communication envelope"),
  gmailSendReceipt: decoderFor(GmailSendReceiptSchema, "Invalid Gmail send receipt")
} as const

const toolResultRequest = makeEncoder<ToolResultInput>(
  encodeToolResultRequestEffect,
  "Invalid tool-result request"
)
const connectionResultRequest = makeEncoder<ConnectionResultInput>(
  encodeConnectionResultRequestEffect,
  "Invalid connection-result request"
)
const cancelRequest = makeEncoder<CancelInput>(
  encodeCancelRequestEffect,
  "Invalid chat cancellation request"
)
const enqueueRequest = makeEncoder<EnqueueChatMessageInput>(
  encodeEnqueueChatMessageRequestEffect,
  "Invalid queued-message request"
)

/** Plain reusable JSON bodies. Message bodies contain a private retry identity. */
export const chatRequests = {
  message(input: ChatMessageInput): PreparedChatMessage {
    return runBoundary(
      encodeChatMessageRequestEffect(input),
      "Invalid chat-message request",
      "encode"
    )
  },
  toolResult: toolResultRequest,
  connectionResult: connectionResultRequest,
  cancel: cancelRequest,
  reorderQueue: makeEncoder<ReorderChatQueueInput>(
    encodeReorderChatQueueRequestEffect,
    "Invalid queue order"
  ),
  enqueue: enqueueRequest
} as const

/** Validated paths for live Chat, history, read, and cancellation routes. */
export const chatRoutes = {
  message: "/chat/message",
  toolResult: "/tools/result",
  connectionResult: "/connections/result",
  connectionResume: "/connections/resume",
  cancel: "/cancel",
  runsStatus: "/chat/runs/status",
  history(options: HistoryRouteOptions = {}): string {
    return runBoundary(encodeHistoryPathEffect(options), "Invalid history route", "encode")
  },
  turnWork(options: TurnWorkRouteOptions): string {
    return runBoundary(encodeTurnWorkPathEffect(options), "Invalid turn-work route", "encode")
  },
  turnDetails(options: TurnDetailsRouteOptions): string {
    return runBoundary(encodeTurnDetailsPathEffect(options), "Invalid turn-details route", "encode")
  },
  toolCall(options: ToolCallRouteOptions): string {
    return runBoundary(encodeToolCallPathEffect(options), "Invalid tool-call route", "encode")
  },
  toolResultValue(options: ToolResultValueRouteOptions): string {
    return runBoundary(
      encodeToolResultValuePathEffect(options),
      "Invalid tool-result route",
      "encode"
    )
  },
  markRead(address: ReadAddress): string {
    return runBoundary(
      encodeReadPathEffect({ sessionId: address.sessionId }),
      "Invalid session-read route",
      "encode"
    )
  },
  events(sessionId: string): string {
    return runBoundary(encodeEventPathEffect({ sessionId }), "Invalid chat event route", "encode")
  },
  /** The Session queue path serves GET and POST. */
  queue(sessionId: string): string {
    return runBoundary(
      encodeQueuePathEffect({ sessionId }),
      "Invalid Session queue route",
      "encode"
    )
  },
  queuedMessage(address: QueuedMessageAddress): string {
    return runBoundary(
      encodeQueuedMessagePathEffect(address),
      "Invalid queued-message route",
      "encode"
    )
  }
} as const

export { APPROVAL_FIELD_LABEL, canDenyApprovalByReply } from "./approval-presentation.js"
