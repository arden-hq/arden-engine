/**
 * The root export surface of @arden-hq/loop. The subpath exports are
 * "./providers/openai-responses" (the bundled provider) and "./provider-kit"
 * (what a provider needs besides these contracts); everything else imports the root.
 */

export { pendingBackgroundCalls } from "./agent/background-tools.js"
export { isConversationalInput, isHumanMessage } from "./agent/interactions.js"
export type { InputEnvelope } from "./agent/interactions.js"
export { makeAgent } from "./agent/agent.js"
export { resolveModelCapabilities } from "./agent/provider-capabilities.js"
export type { Agent, AgentInvocationOptions, AgentOptions } from "./agent/agent.js"
export type { AgentCostGetter } from "./agent/run-state.js"
export type { HistoryChange } from "./agent/history-journal.js"
export type { AgentOutputOptions } from "./agent/structured-output.js"

export type { AgentConfig, AgentConfigInput } from "./agent/config.js"

export {
  AgentCallbackError,
  AgentInvariantError,
  HookError,
  InvalidAgentConfigError,
  InvalidModelResponseError,
  LoopError,
  ModelProviderError,
  ModelRequestMiddlewareError,
  PauseRequested,
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
export type { AgentError, ProviderErrorCode, ToolFailure } from "./errors.js"

export { ToolChoice, usageInputTokens } from "./contracts/provider.js"
export { decodeMessage } from "./internal/validate.js"
export { makeRunBudget } from "./agent/budget.js"

export { createTool, createToolset, INVALID_ARGUMENTS_OUTCOME } from "./tools/tool.js"
export type {
  CreateToolsetOptions,
  JsonSchemaConverter,
  LoopToolMetadata,
  Tool,
  ToolApprovalCall,
  ToolApprovalDecision,
  ToolApprovalGate,
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
  AssistantTextPhase,
  AudioContent,
  ChatMessage,
  ContentBlock,
  ContextContent,
  FunctionCall,
  ImageContent,
  Interaction,
  InteractionActor,
  InteractionActorType,
  InteractionReference,
  ReplyContext,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  MaybePromise,
  MessageIdMinter,
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
  ToolResultMessage,
  UserMessage
} from "./contracts/messages.js"
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
export type {
  CompletionResponse,
  FinishReason,
  ModelCapabilities,
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
export type {
  AgentEvent,
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
  StopReason,
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
