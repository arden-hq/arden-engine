import { Effect, Result, Schema, SchemaIssue } from "effect"

import {
  createParentPortRpc,
  type ParentPortFailure,
  type ParentPortResponse,
  type ParentPortSender
} from "../runtime/parent-port-rpc.js"
import {
  BrowserClientError,
  BrowserErrorCodeSchema,
  BrowserOutputSchema,
  dispatchesPageChange,
  type BrowserBroker,
  type BrowserOutput,
  type ScopedBrowserRequest
} from "./service.js"

const DEFAULT_TIMEOUT_MS = 65_000

const RequestIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))

const BrowserSuccessSchema = Schema.Struct({
  type: Schema.Literal("browser_response"),
  requestId: RequestIdSchema,
  ok: Schema.Literal(true),
  output: BrowserOutputSchema
})

const BrowserFailureSchema = Schema.Struct({
  type: Schema.Literal("browser_response"),
  requestId: RequestIdSchema,
  ok: Schema.Literal(false),
  error: Schema.Struct({
    code: BrowserErrorCodeSchema,
    message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
    retryable: Schema.Boolean,
    outcomeUnknown: Schema.Boolean
  })
})

const BrowserResponseSchema = Schema.Union([BrowserSuccessSchema, BrowserFailureSchema])

const isBrowserResponse = Schema.is(BrowserResponseSchema)

type BrowserResponseError = Extract<
  typeof BrowserResponseSchema.Type,
  { readonly ok: false }
>["error"]

export interface BrowserBrokerBridge extends BrowserBroker {
  readonly handleMessage: (input: unknown) => boolean
  readonly close: () => void
}

export const createBrowserBrokerBridge = (
  parentPort: ParentPortSender,
  timeoutMs = DEFAULT_TIMEOUT_MS
): BrowserBrokerBridge => {
  const rpc = createParentPortRpc(parentPort, {
    type: "browser_request",
    timeoutMs,
    decode: decodeBrowserResponse,
    cancelMessage: "browser_cancel"
  })

  const request = (input: ScopedBrowserRequest, signal: AbortSignal): Promise<BrowserOutput> => {
    const action = dispatchesPageChange(input.operation)
    return rpc.request(
      { sessionId: input.sessionId, operation: input.operation, scope: input.scope },
      { signal, fail: (failure) => browserFailure(failure, action) }
    )
  }

  return { request, handleMessage: rpc.handleMessage, close: rpc.abortAll }
}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) => issue._tag,
  checkHook: (issue) => {
    const expected = issue.filter.annotations?.expected
    return typeof expected === "string" ? `Expected ${expected}` : "Failed a check"
  }
})

const describeInvalidBrowserResponse = (input: object): ReadonlyArray<string> => {
  const schema = "ok" in input && input.ok === false ? BrowserFailureSchema : BrowserSuccessSchema
  const decoded = Schema.decodeUnknownResult(schema)(input, { errors: "all" })
  if (Result.isSuccess(decoded)) return []
  return formatIssues(decoded.failure.issue)
    .issues.slice(0, 8)
    .map((issue) => {
      const path = issue.path?.map((key) => String(typeof key === "object" ? key.key : key))
      return path === undefined || path.length === 0
        ? issue.message
        : `${path.join(".")}: ${issue.message}`
    })
}

const decodeBrowserResponse = (
  input: unknown
): ParentPortResponse<BrowserOutput, BrowserResponseError> | undefined => {
  if (
    typeof input !== "object" ||
    input === null ||
    !("type" in input) ||
    input.type !== "browser_response"
  )
    return undefined
  if (!isBrowserResponse(input)) {
    const requestId =
      "requestId" in input && typeof input.requestId === "string" ? input.requestId : ""
    Effect.runSync(
      Effect.logWarning("Arden Desktop sent a browser response the server could not decode", {
        issues: describeInvalidBrowserResponse(input)
      })
    )
    return { kind: "invalid", requestId }
  }
  return input.ok
    ? { kind: "value", requestId: input.requestId, value: input.output }
    : { kind: "error", requestId: input.requestId, error: input.error }
}

const browserFailure = (
  failure: ParentPortFailure<BrowserResponseError>,
  action: boolean
): BrowserClientError => {
  switch (failure.kind) {
    case "aborted":
      return failure.dispatched
        ? new BrowserClientError({
            code: "browser_cancelled",
            message: action
              ? "Browser action was cancelled after dispatch; inspect the page before another action"
              : "Browser request was cancelled",
            retryable: !action,
            outcomeUnknown: action
          })
        : new BrowserClientError({
            code: "browser_cancelled",
            message: "Browser request was cancelled",
            retryable: true,
            outcomeUnknown: false
          })
    case "timeout":
      return new BrowserClientError({
        code: action ? "browser_action_outcome_unknown" : "browser_internal_error",
        message: action
          ? "The browser action timed out after dispatch; inspect the page before another action"
          : "Arden Desktop browser request timed out",
        retryable: !action,
        outcomeUnknown: action
      })
    case "stopped":
      return new BrowserClientError({
        code: action ? "browser_action_outcome_unknown" : "browser_cancelled",
        message: action
          ? "Browser broker stopped after action dispatch; inspect the page before another action"
          : "Browser broker stopped",
        retryable: !action,
        outcomeUnknown: action
      })
    case "dispatch_failed":
      return new BrowserClientError({
        code: "browser_internal_error",
        message: "Browser request could not be dispatched",
        retryable: true,
        outcomeUnknown: false
      })
    case "invalid_response":
      return new BrowserClientError({
        code: action ? "browser_action_outcome_unknown" : "browser_internal_error",
        message: action
          ? "Arden's browser sent back a reply Arden could not read, so it is unknown whether the action ran. Take a fresh snapshot before another action."
          : "Arden's browser sent back a reply Arden could not read. Retrying will fail the same way; use browser_screenshot or web_fetch instead.",
        retryable: false,
        outcomeUnknown: action
      })
    case "rejected":
      return new BrowserClientError(failure.error)
  }
}
