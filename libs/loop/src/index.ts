export { pendingBackgroundCalls } from "./agent/background-tools.js"
export { isConversationalInput, isHumanMessage } from "./agent/interactions.js"
export type { InputEnvelope } from "./agent/interactions.js"
export { makeAgent } from "./agent/agent.js"
export { resolveModelCapabilities } from "./agent/provider-capabilities.js"
export type { Agent, AgentInvocationOptions, AgentOptions } from "./agent/agent.js"
export type { AgentCostGetter } from "./agent/run-state.js"
export { HISTORY_CHANGE_KIND, type HistoryChange } from "./agent/history-journal.js"
export type { AgentOutputOptions } from "./agent/structured-output.js"

export type { AgentConfig, AgentConfigInput } from "./agent/config.js"

export {
  AgentCallbackError,
  AgentInvariantError,
  HookError,
  InvalidAgentConfigError,
  InvalidModelResponseError,
  LOOP_ERROR_TAG,
  LoopError,
  ModelProviderError,
  ModelRequestMiddlewareError,
  PAUSE_REASON,
  PauseRequested,
  PROVIDER_ERROR_CODE,
  ProtocolContractError,
  StructuredOutputError,
  UnsupportedStructuredOutputError,
  ToolExecutionError,
  ToolsetError,
  failedToolResult,
  isProviderErrorCode,
  providerErrorCode,
  toToolFailure
} from "./errors.js"
export type {
  AgentError,
  LoopErrorTag,
  PauseReason,
  ProviderErrorCode,
  ToolFailure
} from "./errors.js"

export {
  addCost,
  DELIVERY_MODE,
  MODEL_PROVIDER_PROTOCOL,
  MODEL_STREAM_ITEM_TAG,
  REASONING_EFFORT,
  STEERING_MODE,
  STRUCTURED_OUTPUT_SUPPORT,
  TOOL_SEARCH_MODE,
  ToolChoice,
  usageInputTokens
} from "./contracts/provider.js"
export type {
  DeliveryMode,
  ModelStreamItemTag,
  ReasoningEffort,
  SteeringMode,
  StructuredOutputSupport,
  ToolSearchMode
} from "./contracts/provider.js"
export {
  ASSISTANT_OUTPUT_PART_TYPE,
  ASSISTANT_TEXT_PHASE,
  CONTENT_BLOCK_TYPE,
  TOOL_CALL_TYPE,
  TOOL_EXECUTION
} from "./contracts/messages.js"
export { decodeMessage } from "./internal/validate.js"
export { makeRunBudget } from "./agent/budget.js"

export {
  createTool,
  createToolset,
  INVALID_ARGUMENTS_OUTCOME,
  TOOL_APPROVAL_DECISION,
  TOOL_APPROVAL_POLICY
} from "./tools/tool.js"
export type {
  CreateToolsetOptions,
  JsonSchemaConverter,
  LoopToolMetadata,
  Tool,
  ToolApprovalCall,
  ToolApprovalDecision,
  ToolApprovalGate,
  ToolApprovalPolicy,
  ToolApprovalPrompt,
  ToolContext,
  ToolDefinition,
  ToolExecuteOptions,
  ToolMetadata,
  ToolResultOutput
} from "./tools/tool.js"

export {
  DEFAULT_TRUNCATE_MAX_BYTES,
  DEFAULT_TRUNCATE_MAX_LINES,
  truncateToolResult
} from "./tools/truncate.js"
export type { TruncateToolResultOptions } from "./tools/truncate.js"

export { defaultToolSearchStrategy, makeToolSearch } from "./tools/search.js"
export { splitToolArguments } from "./tools/display-title.js"
export { makeFairReadWriteLock } from "./internal/concurrency.js"
export type { ToolSearchDocument, ToolSearchStrategy } from "./tools/search.js"

export type {
  AssistantMessage,
  AssistantOutputPart,
  AssistantOutputPartType,
  AssistantTextPhase,
  AudioContent,
  ChatMessage,
  ContentBlock,
  ContentBlockType,
  ContextContent,
  FunctionCall,
  ImageContent,
  InteractionActor,
  InteractionKind,
  InteractionMessage,
  InteractionOutcome,
  InteractionRecipient,
  InteractionReference,
  InteractionSource,
  ReplyContext,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  MaybePromise,
  MessageIdMinter,
  MessageOrigin,
  Metadata,
  ModelContentBlock,
  ModelMessage,
  ProviderState,
  ProviderToolCall,
  Role,
  StandardSchemaV1,
  SystemMessage,
  TextContent,
  AsyncToolLaunch,
  ToolCall,
  ToolCallType,
  ToolExecution,
  ToolResultMessage,
  UserMessage
} from "./contracts/messages.js"
export { replyContexts } from "./agent/replies.js"
export { callEndsTurn, mayEndTurn } from "./contracts/tools.js"
export type {
  EndsTurn,
  HeldToolCall,
  JsonSchema,
  PendingToolCall,
  ToolApprovalContext,
  ToolApprovalEdits,
  ToolArgumentError,
  ToolArgumentErrorCode,
  ToolCallMiddleware,
  ToolCallNext,
  ToolCallRequest,
  ToolDeclaration,
  ToolEntry,
  ToolInputSource,
  ToolMeta,
  ToolSearch,
  ToolSearchResult,
  ToolPhase,
  ToolProgressUpdate,
  ToolResult,
  Toolset,
  ToolDisplayTitle
} from "./contracts/tools.js"
export { FinishReason } from "./contracts/provider.js"
export type {
  CompletionResponse,
  ModelCapabilities,
  ImageInput,
  ImageInputLimits,
  ModelProvider,
  ModelProviderRequest,
  ModelProviderSession,
  ModelRequest,
  ModelRequestMiddleware,
  ModelRequestNext,
  ModelSource,
  ModelStreamItem,
  ProviderMessage,
  ProviderStreamRetry,
  ProviderToolCallDelta,
  ReasoningContentDelta,
  ResponseFormat,
  TextContentDelta,
  ToolCallStreamDelta,
  OutputItemReady,
  Usage
} from "./contracts/provider.js"
export { AGENT_EVENT_TAG, StopReason } from "./contracts/events.js"
export type {
  AgentEvent,
  AgentEventTag,
  AgentHooks,
  AgentStreamEvent,
  EventBase,
  FinalTextSuperseded,
  InputTaken,
  ModelResponseReset,
  ModelStreamRetry,
  PendingToolRequest,
  ReasoningDelta,
  ReasoningEnded,
  ReasoningStarted,
  Result,
  RunBudget,
  RunBudgetOptions,
  RunBudgetSnapshot,
  RunPolicy,
  TextDelta,
  TextEnded,
  TextPhaseResolved,
  TextStarted,
  ToolCompleted,
  ToolInputDelta,
  ToolInputEnded,
  ToolInputStarted,
  ToolPaused,
  ToolProgress,
  ToolStarted
} from "./contracts/events.js"
