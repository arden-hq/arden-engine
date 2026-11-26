import { ChangeEvidenceSchema } from "./change-evidence.js"
export type {
  ChangeEvidence,
  ChangeEntry,
  ChangeEntryLink,
  ChangeEntryPlace,
  ChangeEntryTitle
} from "./change-evidence.js"
export {
  CHANGE_ENTRY_COMPARISON,
  CHANGE_ENTRY_DOMAIN,
  CHANGE_ENTRY_LINK,
  CHANGE_ENTRY_OUTCOME,
  CHANGE_ENTRY_PLACE,
  CHANGE_ENTRY_TITLE,
  CHANGE_ENTRY_VERSION,
  type ChangeEntryComparison,
  type ChangeEntryDomain,
  type ChangeEntryOutcome
} from "./change-evidence.js"
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
  ChatAcknowledgementSchema,
  ChatReceiptResponseSchema,
  ConnectionResumeResponseSchema,
  encodeToolCallPathEffect,
  encodeToolResultValuePathEffect,
  QueuedCancelResponseSchema,
  QueuedChatMessageSchema,
  QueuedChatMessagesSchema,
  RunsStatusSchema,
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
  mapCancelResponse,
  mapChatAcknowledgement,
  mapChatReceipt,
  mapQueuedCancelResponse,
  mapReadResponse,
  mapRunsStatus
} from "./facade-mappers.js"
export { historyWindow, turnWorkWindow } from "./facade-mappers.js"
import { PersistedChildAgentMetadataSchema } from "./child-agent.js"
import { CommunicationEnvelopeSchema } from "./communication-schema.js"
import { ServerEventSchema } from "../events/schema.js"
import { GmailSendReceiptSchema } from "./gmail-receipt.js"

export * from "./contracts.js"
export {
  ACTIVE_WORK,
  ACTOR_NAME,
  CHAT_SENT_FROM,
  CONNECTION_ARRIVAL,
  IMAGE_MEDIA_TYPE,
  INTERACTION_PREVIEW,
  INTERACTION_REFERENCE,
  SENDER_ADDRESS,
  SENDER_CAUSE,
  INTERACTION_KINDS,
  INTERACTION_OUTCOMES,
  INTERACTION_SOURCES,
  PAGE_BOUNDS,
  pageBounds,
  TOOL_COUNT_NAME,
  TURN_ENDING
} from "./history.js"
export {
  AGENT_RESULT_ROW,
  AUTOMATION_ROW,
  COMMUNICATION_ROW,
  CONNECTION_ROW,
  CONTEXT_TEXT,
  FORWARDED_FROM,
  FROM_CHAT,
  CONTEXT_BLOCK,
  MESSAGE_CLIENT,
  OUTPUT_PART,
  QUESTION_ANSWER_ROW,
  REASONING_ROW,
  SENT_FROM,
  STEER_STAMP,
  TEXT_PHASE,
  UPDATE_ROW
} from "./history-message.js"
export type * from "./history-message.js"
export { CONTEXT_LIMIT, CONTEXT_MODEL } from "./history.js"
export type { ToolResultValueResponse } from "./schema.js"
export { TOOL_RESULT_VALUE, TOOL_RESULT_VALUE_GAP } from "./schema.js"
export * from "./runtime.js"
export {
  reduceRunActivity,
  runActivityView,
  runActivityProjection,
  type RunActivity,
  type RunActivityProjection
} from "./activity.js"
export type * from "./communication.js"
export { ARRIVAL_EVENT, COMMUNICATION_DOOR, UPDATE_WEIGHT } from "./communication.js"
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
  FAILURE_SURFACE,
  failureSentence,
  inTaskWords,
  isRequestInvalid,
  providerSentence,
  runFailureText,
  RUN_FAILURE_TEXT,
  type FailureSurface,
  type RunFailureText
} from "./run-failure.js"
export { RESTART_INTERRUPTION } from "./restart-words.js"
export { MAX_TOOL_DISPLAY_TITLE_LENGTH, TOOL_DISPLAY_TITLE_ARGUMENT } from "./tool-display.js"
export {
  DEFAULT_TOOL_KIND,
  isToolKind,
  toolKindOf,
  TOOL_KIND,
  ToolKindSchema,
  type ToolKind,
  GMAIL_SEND,
  TOOL_DATA,
  TOOL_EXECUTION,
  TOOL_ICON,
  TOOL_NOUN,
  TOOL_PARENT,
  TOOL_PRESENTATION,
  TOOL_RETRY,
  TOOL_SOURCE,
  TOOL_TITLE,
  toolRetry,
  type GmailSend,
  type ToolData,
  type ToolExecution,
  type ToolFace,
  type ToolIcon,
  type ToolNoun,
  type ToolParent,
  type ToolPresentation,
  type ToolRetry,
  type ToolSource,
  type ToolTitle
} from "./tool-face.js"
export {
  TOOL_CALL_RESULT,
  TOOL_CALL_STARTED,
  TOOL_CALL_STATUS,
  TOOL_DURATION,
  type ToolCallResult,
  type ToolCallStarted,
  type ToolCallStatus,
  type ToolDuration
} from "./history-tool-call.js"
export {
  APPROVAL_ATTACHMENT,
  APPROVAL_PRESENTATION_LIMITS,
  COMMAND_BODY_LABEL,
  IMAGE_RING,
  INLINE_IMAGE_PATTERN,
  NEEDS_GRANT,
  PRESENTATION_BODY,
  PRESENTATION_IMAGE,
  PRESENTATION_TEXT,
  PREVIOUS_VALUE
} from "./approval-presentation.js"
export type {
  ApprovalAttachment,
  ApprovalEditable,
  ApprovalPresentation,
  ApprovalPresentationBody,
  ApprovalPresentationEditable,
  ApprovalPresentationField,
  ApprovalPresentationGrant,
  ApprovalPresentationImage,
  NeedsGrant,
  PresentationBody,
  PresentationImage,
  PresentationText,
  PreviousValue
} from "./approval-presentation.js"
export { CAPABILITY_CANDIDATE } from "./capability-proposal.js"
export type { CapabilityCandidate, CapabilityProposal } from "./capability-proposal.js"
export { TOOL_OUTPUT_STREAM, type ToolOutputStream } from "./events/tool.js"
export { DECISION_ROUTE_SOURCE, type DecisionRouteSource } from "./events/approval.js"
export { INTERACTION_KIND } from "@arden-hq/std/message-vocabulary"
export type { ChatRunErrorCode, RunTerminalEvent, TransientRunErrorCode } from "./events/run.js"
export { CHAT_RUN_ERROR_CODE, isLastingRunError, TRANSIENT_RUN_ERROR_CODES } from "./events/run.js"
export {
  AUTOMATION_PROMPT,
  CONTEXT_SIZE,
  contextSize,
  contextUsage,
  RUN_ACTIVITY_TARGET,
  TOKEN_USAGE_SCOPE,
  isTokenUsageScope,
  RUN_CAUSE,
  RUN_USAGE,
  SESSION_NAME,
  type AutomationPrompt,
  type ContextSize,
  type RunActivityTarget,
  type RunCause,
  type RunUsage,
  type SessionName
} from "./events/run.js"
export { endsReadingMessage, isRunTerminalEvent } from "./events/run.js"

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

export const chatRoutes = {
  message: "/chat/message",
  toolResult: "/tools/result",
  connectionResult: "/connections/result",
  connectionResume: "/connections/resume",
  cancel: "/cancel",
  runsStatus: "/chat/runs/status",
  history(options: HistoryRouteOptions): string {
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

export {
  APPROVAL_FIELD_LABEL,
  canDenyApprovalByReply,
  VERIFY_OUTCOME_ACTION,
  EDITABLE_KIND
} from "./approval-presentation.js"
export {
  CONTENT_START,
  MESSAGE_CLOSURE,
  messageEnd,
  STREAM_RECORD,
  type ContentStart,
  type MessageClosure,
  type StreamRecord
} from "./events/text.js"
export {
  COMPACTION_OUTCOME,
  TODO_EXPLANATION,
  type CompactionOutcome,
  type TodoExplanation
} from "./events/session.js"
