import { decoderFor, runBoundary } from "./common/boundary.js"
import { decodeApiErrorEnvelope, normalizeApiError, ProtocolError } from "./common/errors.js"
import { encodeServerEventFrameEffect } from "./transport/sse-effect.js"
import { ServerEventSchema } from "./events/schema.js"
import {
  decodeServerEventStream,
  decodeServerEventStreamBuffer,
  decodeSseFrameStream,
  decodeSseFrames
} from "./transport/sse.js"
import type { EncodeServerEventOptions } from "./transport/contracts.js"
import type { ServerEvent } from "./events/contracts.js"

export type { JsonPrimitive, JsonValue, JsonRecord } from "./common/json.js"
export type {
  ApprovalPresentationField,
  ApprovalPresentationBody,
  ApprovalPresentation
} from "./chat/approval-presentation.js"
export type { CapabilityCandidate, CapabilityProposal } from "./chat/capability-proposal.js"
export type { RuntimeRunStatus, ConnectionState, ConnectionAction } from "./chat/runtime.js"
export type { SessionType, SessionListItem } from "./sessions/contracts.js"
export type { AppSettingsTabId, AppDestination } from "./common/navigation.js"
export type { TodoStatus, TodoListItem } from "./sessions/todos/contracts.js"
export type {
  ToolOutcome,
  AssistantTextPhase,
  AgentResult,
  Interaction,
  InteractionActor,
  InteractionActorType,
  InteractionOutcome,
  InteractionReference
} from "./chat/history.js"
export type { EventUsage, CommonServerEventFields } from "./common/event-fields.js"
export type {
  RunStartedEvent,
  SessionUpdatedEvent,
  RunFinishedEvent,
  RunCancelledEvent,
  RunErrorEvent,
  TokenUsageEvent,
  ThinkingEvent,
  StreamRetryEvent,
  InputTakenEvent,
  ModelResponseResetEvent,
  FinalTextSupersededEvent,
  RunLifecycleEvent
} from "./chat/events/run.js"
export type {
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessagePhaseEvent,
  TextStreamEvent
} from "./chat/events/text.js"
export type {
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallOutputDeltaEvent,
  ToolCallProgressEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallEvent
} from "./chat/events/tool.js"
export type {
  ReasoningMessageStartEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningStreamEvent
} from "./chat/events/reasoning.js"
export type {
  ApprovalNeededEvent,
  ApprovalResolvedEvent,
  ConnectionNeededEvent,
  ConnectionResolvedEvent,
  ApprovalEvent
} from "./chat/events/approval.js"
export type {
  MessageIngestedEvent,
  TranscriptChangedEvent,
  CompactionStartedEvent,
  CompactionFinishedEvent,
  FocusUpdatedEvent,
  FocusClearedEvent,
  TodoUpdatedEvent,
  SessionStateEvent
} from "./chat/events/session.js"
export type {
  StreamResetEvent,
  AutomationProgressEvent,
  AutomationFinishedEvent,
  RecordToldEvent,
  RecordToldStatus,
  SessionCreatedEvent,
  SessionActivityEvent,
  ChatInputCommittedEvent,
  SessionBlockingWorkEvent,
  NavigationRequestedEvent,
  McpServerChangedEvent,
  EntityChangedEvent,
  EntityKind,
  QuestionChangedEvent,
  TaskVisibilityChangedEvent,
  WorkChangedEvent,
  TaskProposalChangedEvent,
  FocusChoiceChangedEvent,
  TaskWorkRunningEvent,
  TaskWorkEndedEvent,
  TaskWorkChangedEvent,
  AutomationEvent,
  ServerEvent
} from "./events/contracts.js"
export type {
  StreamKeepaliveEvent,
  SessionResumeSnapshot,
  SnapshotProjectionEvent,
  StreamSnapshotEvent,
  StreamLiveEvent,
  StreamOverflowEvent,
  ChatProjectionEvent,
  ChatServerEvent
} from "./chat/events/stream.js"
export type {
  SseFrame,
  SseRetryDirective,
  DecodedServerEventFrame,
  UnknownServerEventFrame,
  SseDecodeOptions,
  EncodeServerEventOptions
} from "./transport/contracts.js"
export type { SessionPresentation, SessionOwner } from "./sessions/presentation.js"
export type * from "./common/errors.js"
export type * from "./visualizations/contracts.js"

export {
  ProtocolError,
  decodeApiErrorEnvelope,
  normalizeApiError,
  decodeServerEventStream,
  decodeServerEventStreamBuffer,
  decodeSseFrameStream,
  decodeSseFrames
}

export {
  VISUALIZATION_LIBRARIES,
  VISUALIZATION_RUNTIME_VERSION
} from "./visualizations/contracts.js"

export { isKnownServerEventType, SERVER_EVENT_TYPES } from "./events/schema.js"

/** Decode one JSON event payload without exposing Effect to consumers. */
export const decodeServerEvent = decoderFor(ServerEventSchema, "Invalid server event")

/** Encode one event as an SSE frame. */
export function encodeServerEventFrame(
  event: ServerEvent,
  options?: EncodeServerEventOptions
): string {
  return runBoundary(encodeServerEventFrameEffect(event, options), "Invalid server event", "encode")
}
