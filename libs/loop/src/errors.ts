import { errorMessage } from "@arden-hq/std/errors"
import type { JsonObject, StandardSchemaV1 } from "./contracts/messages.js"
import type { ToolResult } from "./contracts/tools.js"

export const LOOP_ERROR_TAG = {
  invalidAgentConfigError: "InvalidAgentConfigError",
  protocolContractError: "ProtocolContractError",
  invalidModelResponseError: "InvalidModelResponseError",
  modelProviderError: "ModelProviderError",
  modelRequestMiddlewareError: "ModelRequestMiddlewareError",
  hookError: "HookError",
  toolsetError: "ToolsetError",
  agentInvariantError: "AgentInvariantError",
  agentCallbackError: "AgentCallbackError",
  structuredOutputError: "StructuredOutputError",
  unsupportedStructuredOutputError: "UnsupportedStructuredOutputError",
  pauseRequested: "PauseRequested",
  toolExecutionError: "ToolExecutionError"
} as const
export type LoopErrorTag = (typeof LOOP_ERROR_TAG)[keyof typeof LOOP_ERROR_TAG]

const isLoopErrorTagged = (value: unknown, tag: LoopErrorTag): boolean =>
  typeof value === "object" && value !== null && "_tag" in value && value._tag === tag

export class LoopError extends Error {
  readonly _tag: LoopErrorTag
  override readonly cause?: unknown

  override readonly name: string

  constructor(tag: LoopErrorTag, message: string, cause?: unknown) {
    super(message)
    this.name = tag
    this._tag = tag
    if (cause !== undefined) this.cause = cause
  }
}

export const PROVIDER_ERROR_CODE = {
  contextLengthExceeded: "context_length_exceeded",
  rateLimited: "rate_limited",
  providerAuth: "provider_auth",
  providerUnavailable: "provider_unavailable",
  providerError: "provider_error",
  requestInvalid: "request_invalid",
  modelUnavailable: "model_unavailable"
} as const
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODE)[keyof typeof PROVIDER_ERROR_CODE]

const PROVIDER_ERROR_CODES: ReadonlySet<string> = new Set<ProviderErrorCode>(
  Object.values(PROVIDER_ERROR_CODE)
)

export const isProviderErrorCode = (value: unknown): value is ProviderErrorCode =>
  typeof value === "string" && PROVIDER_ERROR_CODES.has(value)

export const providerErrorCode = (cause: unknown): ProviderErrorCode | undefined => {
  const seen = new Set<unknown>()
  let current: unknown = cause
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    const code = (current as { readonly code?: unknown }).code
    if (isProviderErrorCode(code)) return code
    current = current.cause
  }
  return undefined
}

export class InvalidAgentConfigError extends LoopError {
  constructor(message: string) {
    super(LOOP_ERROR_TAG.invalidAgentConfigError, message)
  }
}

export class ProtocolContractError extends LoopError {
  readonly subject: string

  constructor(subject: string, cause: unknown) {
    super(LOOP_ERROR_TAG.protocolContractError, `invalid ${subject} protocol value`, cause)
    this.subject = subject
  }
}

export class InvalidModelResponseError extends LoopError {
  constructor(message: string) {
    super(LOOP_ERROR_TAG.invalidModelResponseError, message)
  }
}

export class ModelProviderError extends LoopError {
  readonly code: ProviderErrorCode

  constructor(message: string, cause?: unknown) {
    super(LOOP_ERROR_TAG.modelProviderError, message, cause)
    this.code = providerErrorCode(cause) ?? PROVIDER_ERROR_CODE.providerError
  }
}

export class ModelRequestMiddlewareError extends LoopError {
  constructor(message: string, cause?: unknown) {
    super(LOOP_ERROR_TAG.modelRequestMiddlewareError, message, cause)
  }
}

export class HookError extends LoopError {
  readonly hook: string

  constructor(hook: string, message: string, cause?: unknown) {
    super(LOOP_ERROR_TAG.hookError, message, cause)
    this.hook = hook
  }
}

export class ToolsetError extends LoopError {
  constructor(message: string, cause?: unknown) {
    super(LOOP_ERROR_TAG.toolsetError, message, cause)
  }
}

export class AgentInvariantError extends LoopError {
  constructor(message: string) {
    super(LOOP_ERROR_TAG.agentInvariantError, message)
  }
}

export class AgentCallbackError extends LoopError {
  readonly operation: string

  constructor(operation: string, message: string, cause?: unknown) {
    super(LOOP_ERROR_TAG.agentCallbackError, message, cause)
    this.operation = operation
  }
}

export class StructuredOutputError extends LoopError {
  readonly issues: ReadonlyArray<StandardSchemaV1.Issue>

  constructor(message: string, issues: ReadonlyArray<StandardSchemaV1.Issue>) {
    super(LOOP_ERROR_TAG.structuredOutputError, message)
    this.issues = issues
  }
}

export class UnsupportedStructuredOutputError extends LoopError {
  readonly model: string

  constructor(model: string) {
    super(
      LOOP_ERROR_TAG.unsupportedStructuredOutputError,
      `Model ${model} does not support constrained structured output`
    )
    this.model = model
  }
}

export const PAUSE_REASON = { approval: "approval", paused: "paused" } as const

export type PauseReason = (typeof PAUSE_REASON)[keyof typeof PAUSE_REASON]

export class PauseRequested<Presentation = unknown> extends LoopError {
  readonly reason: string
  readonly detail?: string
  readonly preview?: string
  readonly diff?: string
  readonly presentation?: Presentation
  readonly data?: JsonObject

  constructor(
    reason: string,
    detail?: string,
    options: {
      readonly preview?: string
      readonly diff?: string
      readonly presentation?: Presentation
      readonly data?: JsonObject
    } = {}
  ) {
    super(LOOP_ERROR_TAG.pauseRequested, reason)
    this.reason = reason
    if (detail !== undefined) this.detail = detail
    if (options.preview !== undefined) this.preview = options.preview
    if (options.diff !== undefined) this.diff = options.diff
    if (options.presentation !== undefined) this.presentation = options.presentation
    if (options.data !== undefined) this.data = options.data
  }
}

export class ToolExecutionError extends LoopError {
  readonly preview?: string
  readonly retryable?: boolean | null
  readonly diagnosticRef?: string
  readonly host?: Readonly<Record<string, unknown>>

  constructor(
    message: string,
    options: {
      readonly preview?: string
      readonly retryable?: boolean | null
      readonly diagnosticRef?: string
      readonly host?: Readonly<Record<string, unknown>>
    } = {}
  ) {
    super(LOOP_ERROR_TAG.toolExecutionError, message)
    if (options.preview !== undefined) this.preview = options.preview
    if (options.retryable !== undefined) this.retryable = options.retryable
    if (options.diagnosticRef !== undefined) this.diagnosticRef = options.diagnosticRef
    if (options.host !== undefined) this.host = options.host
  }
}

export const failedToolResult = (failure: ToolExecutionError): ToolResult => ({
  content: failure.message,
  preview: failure.preview ?? "Tool execution failed",
  is_error: true,
  retryable: failure.retryable ?? false,
  ...(failure.host === undefined ? {} : { host: failure.host })
})

export type ToolFailure = PauseRequested | ToolExecutionError | ToolsetError

export type AgentError =
  | ProtocolContractError
  | InvalidModelResponseError
  | ModelProviderError
  | ModelRequestMiddlewareError
  | HookError
  | ToolsetError
  | AgentInvariantError
  | AgentCallbackError
  | StructuredOutputError
  | UnsupportedStructuredOutputError

export const toToolFailure = (cause: unknown): PauseRequested | ToolExecutionError => {
  if (cause instanceof PauseRequested || cause instanceof ToolExecutionError) return cause
  const record = (typeof cause === "object" && cause !== null ? cause : {}) as Record<
    string,
    unknown
  >
  if (isLoopErrorTagged(cause, LOOP_ERROR_TAG.pauseRequested)) {
    return new PauseRequested(
      typeof record.reason === "string" ? record.reason : PAUSE_REASON.paused,
      typeof record.detail === "string" ? record.detail : undefined,
      {
        ...(typeof record.preview === "string" ? { preview: record.preview } : {}),
        ...(typeof record.diff === "string" ? { diff: record.diff } : {}),
        ...(typeof record.presentation === "object" &&
        record.presentation !== null &&
        !Array.isArray(record.presentation)
          ? { presentation: record.presentation }
          : {}),
        ...(typeof record.data === "object" && record.data !== null && !Array.isArray(record.data)
          ? { data: record.data as JsonObject }
          : {})
      }
    )
  }
  return new ToolExecutionError(errorMessage(cause), {
    ...(typeof record.preview === "string" ? { preview: record.preview } : {}),
    ...(typeof record.retryable === "boolean" || record.retryable === null
      ? { retryable: record.retryable }
      : {}),
    ...(typeof record.diagnosticRef === "string" ? { diagnosticRef: record.diagnosticRef } : {})
  })
}
