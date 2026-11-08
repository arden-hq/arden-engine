import { errorMessage } from "@arden-hq/std/errors"
import type { JsonObject, StandardSchemaV1 } from "./contracts/messages.js"
import type { ToolResult } from "./contracts/tools.js"

export class LoopError extends Error {
  readonly _tag: string
  override readonly cause?: unknown

  override readonly name: string

  constructor(tag: string, message: string, cause?: unknown) {
    super(message)
    this.name = tag
    this._tag = tag
    if (cause !== undefined) this.cause = cause
  }
}

/**
 * Closed classification of a model-provider failure, attached where the
 * failure is thrown. Hosts map it straight onto their own wire contract
 * instead of re-deriving it from error messages.
 */
export type ProviderErrorCode =
  | "context_length_exceeded"
  | "rate_limited"
  | "provider_auth"
  | "provider_unavailable"
  | "provider_error"
  /**
   * The provider refused the request Arden built (HTTP 400
   * `invalid_request_error`), or the adapter could not build one from the
   * stored history. Arden's defect, not the person's input or the weather.
   */
  | "request_invalid"
  /**
   * The provider will not run the requested model for this account or route:
   * a model it does not offer, or one this sign-in may not use. Trying again
   * never helps; only another model or another account does.
   */
  | "model_unavailable"

const PROVIDER_ERROR_CODES: ReadonlySet<string> = new Set<ProviderErrorCode>([
  "context_length_exceeded",
  "rate_limited",
  "provider_auth",
  "provider_unavailable",
  "provider_error",
  "request_invalid",
  "model_unavailable"
])

export const isProviderErrorCode = (value: unknown): value is ProviderErrorCode =>
  typeof value === "string" && PROVIDER_ERROR_CODES.has(value)

/** The classification carried by `cause`, or by the nearest of its causes that has one. */
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
    super("InvalidAgentConfigError", message)
  }
}

export class ProtocolContractError extends LoopError {
  readonly subject: string

  constructor(subject: string, cause: unknown) {
    super("ProtocolContractError", `invalid ${subject} protocol value`, cause)
    this.subject = subject
  }
}

export class InvalidModelResponseError extends LoopError {
  constructor(message: string) {
    super("InvalidModelResponseError", message)
  }
}

export class ModelProviderError extends LoopError {
  readonly code: ProviderErrorCode

  constructor(message: string, cause?: unknown) {
    super("ModelProviderError", message, cause)
    this.code = providerErrorCode(cause) ?? "provider_error"
  }
}

export class ModelRequestMiddlewareError extends LoopError {
  constructor(message: string, cause?: unknown) {
    super("ModelRequestMiddlewareError", message, cause)
  }
}

export class HookError extends LoopError {
  readonly hook: string

  constructor(hook: string, message: string, cause?: unknown) {
    super("HookError", message, cause)
    this.hook = hook
  }
}

export class ToolsetError extends LoopError {
  constructor(message: string, cause?: unknown) {
    super("ToolsetError", message, cause)
  }
}

export class AgentInvariantError extends LoopError {
  constructor(message: string) {
    super("AgentInvariantError", message)
  }
}

export class AgentCallbackError extends LoopError {
  readonly operation: string

  constructor(operation: string, message: string, cause?: unknown) {
    super("AgentCallbackError", message, cause)
    this.operation = operation
  }
}

/**
 * The final text failed structured-output validation even after the one
 * correction retry. Carries the Standard Schema issues of the last attempt.
 */
export class StructuredOutputError extends LoopError {
  readonly issues: ReadonlyArray<StandardSchemaV1.Issue>

  constructor(message: string, issues: ReadonlyArray<StandardSchemaV1.Issue>) {
    super("StructuredOutputError", message)
    this.issues = issues
  }
}

/** The effective model route cannot constrain a requested structured response. */
export class UnsupportedStructuredOutputError extends LoopError {
  readonly model: string

  constructor(model: string) {
    super(
      "UnsupportedStructuredOutputError",
      `Model ${model} does not support constrained structured output`
    )
    this.model = model
  }
}

/**
 * A host deliberately suspended a tool while it waits for external input.
 * `presentation` is the host's own card shape; the loop carries it untouched.
 */
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
    super("PauseRequested", reason)
    this.reason = reason
    if (detail !== undefined) this.detail = detail
    if (options.preview !== undefined) this.preview = options.preview
    if (options.diff !== undefined) this.diff = options.diff
    if (options.presentation !== undefined) this.presentation = options.presentation
    if (options.data !== undefined) this.data = options.data
  }
}

/** A safe, model-facing tool failure reported by a host adapter. */
export class ToolExecutionError extends LoopError {
  readonly preview?: string
  readonly retryable?: boolean | null
  readonly diagnosticRef?: string
  /** Host facts the failed call still carries into its result (`ToolResult.host`). */
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
    super("ToolExecutionError", message)
    if (options.preview !== undefined) this.preview = options.preview
    if (options.retryable !== undefined) this.retryable = options.retryable
    if (options.diagnosticRef !== undefined) this.diagnosticRef = options.diagnosticRef
    if (options.host !== undefined) this.host = options.host
  }
}

/** The failed result a thrown {@link ToolExecutionError} becomes in the transcript. */
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

const isTagged = (value: unknown): value is { readonly _tag: string } =>
  typeof value === "object" && value !== null && "_tag" in value && typeof value._tag === "string"

/** Normalize a thrown tool failure at the loop boundary. */
export const toToolFailure = (cause: unknown): PauseRequested | ToolExecutionError => {
  if (cause instanceof PauseRequested || cause instanceof ToolExecutionError) return cause
  const record = (typeof cause === "object" && cause !== null ? cause : {}) as Record<
    string,
    unknown
  >
  if (isTagged(cause) && cause._tag === "PauseRequested") {
    return new PauseRequested(
      typeof record.reason === "string" ? record.reason : "paused",
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
