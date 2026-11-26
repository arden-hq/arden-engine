import { ROLE } from "@arden-hq/std/message-vocabulary"
import type { Metadata } from "../../contracts/messages.js"
import {
  DELIVERY_MODE,
  isCompletionResponse,
  STEERING_MODE,
  type ModelCapabilities,
  type ModelProvider,
  type ModelProviderSession,
  type ModelStreamItem,
  type CompletionResponse,
  type ModelProviderRequest
} from "../../contracts/provider.js"
import {
  raceAbort,
  backoffSleep,
  isRetryableFailure,
  nextRetry,
  retryDelayMs,
  RetryableProviderError,
  HttpStatusError
} from "../kit/index.js"
import { errorMessage } from "@arden-hq/std/errors"
import { abortAfter, every } from "@arden-hq/std/timer"
import { isResponseErrorCode, OpenAiResponsesProviderError, RESPONSE_ERROR_CODE } from "./errors.js"
import {
  asRecord,
  INCOMPLETE_REASON,
  incompleteReason,
  RESPONSE_EVENT_TYPE,
  RESPONSE_ITEM_TYPE,
  type RawResponseEvent
} from "./items.js"
import { makePayload, responsesRoute } from "./request.js"
import { makeEventMapper, responseCode, responseFailureMessage } from "./response.js"
import {
  continuationInput,
  incrementalInput,
  responseContinuation,
  type ResponseContinuation
} from "./continuation.js"

const RESPONSES_TRANSPORT = { sse: "sse", websocket: "websocket" } as const
export type ResponsesTransport = (typeof RESPONSES_TRANSPORT)[keyof typeof RESPONSES_TRANSPORT]

const NEXT_REQUEST = { create: "create", automatic: "automatic", required: "required" } as const
type NextRequest = (typeof NEXT_REQUEST)[keyof typeof NEXT_REQUEST]

const STEER = { submitted: "submitted", accepted: "accepted" } as const

const isPortable = (capabilities: ModelCapabilities): boolean =>
  capabilities.steering !== STEERING_MODE.native && capabilities.asyncTools !== DELIVERY_MODE.native

export interface ResponsesWebSocket {
  readonly isClosed: () => boolean
  readonly events: AsyncIterable<unknown>
  readonly send: (event: Metadata) => void
  readonly close: () => void
}

export type ConnectResponsesWebSocket = (options: {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly signal: AbortSignal
}) => Promise<ResponsesWebSocket>

export const openResponsesSession = (options: {
  readonly connect: ConnectResponsesWebSocket
  readonly headers: (signal: AbortSignal, forceRefresh: boolean) => Promise<Record<string, string>>
  readonly baseUrl: string
  readonly providerId: string
  readonly modelPrefix: string
  readonly defaultInstructions?: string
  readonly omitMaxOutputTokens?: boolean
  readonly maxAttempts: number
  readonly idleTimeoutMs: number
  readonly capabilities: NonNullable<ModelProvider["capabilities"]>
  readonly transport: (model: string) => ResponsesTransport
  readonly cacheScopeHeader?: string
  readonly fallback: ModelProvider["stream"]
}): ModelProviderSession => {
  const lifetime = new AbortController()
  let connection:
    | { readonly socket: ResponsesWebSocket; readonly events: AsyncIterator<unknown> }
    | undefined
  let saved: RawResponseEvent | undefined
  let next: NextRequest = NEXT_REQUEST.create
  let responseId: string | undefined
  let priorInput: ReadonlyArray<Metadata> = []
  let steeredInput: ReadonlyArray<Metadata> = []
  let pending:
    | { readonly kind: typeof STEER.submitted; readonly target: string }
    | { readonly kind: typeof STEER.accepted; readonly target: string; readonly id: string }
    | undefined
  let route: { readonly model: string; readonly cacheScope: string | undefined } | undefined
  let previous: ResponseContinuation | undefined
  let socketUnavailable = false

  const close = () => {
    connection?.socket.close()
    connection = undefined
    saved = undefined
    pending = undefined
    next = NEXT_REQUEST.create
    responseId = undefined
    priorInput = []
    steeredInput = []
    previous = undefined
  }

  const streamAttempt = async function* (
    request: ModelProviderRequest,
    recoveredRejections: Set<"context" | "missing">,
    forceRefresh: boolean
  ): AsyncGenerator<ModelStreamItem> {
    const capabilities = await options.capabilities(request.model)
    if (
      route !== undefined &&
      (route.model !== request.model || route.cacheScope !== request.cacheScope)
    )
      close()
    if (isPortable(capabilities) && connection?.socket.isClosed()) close()
    route = { model: request.model, cacheScope: request.cacheScope }
    const signal = AbortSignal.any([
      lifetime.signal,
      ...(request.signal === undefined ? [] : [request.signal])
    ])
    const requestPayload =
      options.omitMaxOutputTokens === true
        ? (({ maxOutputTokens: _, ...rest }) => rest)(request)
        : request
    const payload = makePayload(
      requestPayload,
      options.modelPrefix,
      options.defaultInstructions,
      responsesRoute(capabilities)
    )
    const delta =
      capabilities.steering === STEERING_MODE.native || previous === undefined
        ? undefined
        : incrementalInput(payload, previous)
    const additionalInput = continuationInput(payload.input, priorInput, steeredInput)
    const automatic = next === NEXT_REQUEST.automatic
    const carry = automatic ? additionalInput.filter((item) => item.role === ROLE.user) : []
    const deferredOutputs =
      automatic &&
      additionalInput.some((item) => item.type === RESPONSE_ITEM_TYPE.functionCallOutput)
    const onAbort = () => connection?.socket.close()
    signal.addEventListener("abort", onAbort, { once: true })
    let polling = false
    let pollFailure: { readonly cause: unknown } | undefined
    let generating = false
    let failedSteer = false
    let terminal: CompletionResponse | undefined
    let terminalRaw: RawResponseEvent | undefined
    let progressed = false
    let refreshHeaders = forceRefresh
    const map = makeEventMapper({
      requestedModel: request.model,
      toolSearch: request.toolSearch,
      providerId: options.providerId
    })
    let pollWork = Promise.resolve()
    const poll = () => {
      if (
        capabilities.steering !== STEERING_MODE.native ||
        !generating ||
        polling ||
        pending !== undefined ||
        responseId === undefined ||
        signal.aborted
      )
        return
      polling = true
      pollWork = (async () => {
        const target = responseId
        const messages = (await request.steering?.take()) ?? []
        if (messages.length === 0 || signal.aborted) return
        if (target === undefined) return
        pending = { kind: STEER.submitted, target }
        const input = makePayload(
          { ...request, messages, tools: [], deferredTools: [] },
          options.modelPrefix,
          undefined,
          responsesRoute(capabilities)
        ).input
        steeredInput = [...steeredInput, ...input]
        if (connection === undefined)
          throw new Error("Responses socket closed before the steer was sent")
        connection.socket.send({ type: "response.steer", previous_response_id: target, input })
      })()
        .catch((cause: unknown) => {
          pollFailure = { cause }
          connection?.socket.close()
        })
        .finally(() => {
          polling = false
        })
    }
    const timer = every(100, poll)
    const connect = async () => {
      const headers = await options.headers(signal, refreshHeaders)
      refreshHeaders = false
      const socket = await options
        .connect({
          url: `${options.baseUrl.replace(/^http/, "ws")}/responses`,
          headers: {
            ...headers,
            ...(options.cacheScopeHeader === undefined || request.cacheScope === undefined
              ? {}
              : { [options.cacheScopeHeader]: request.cacheScope })
          },
          signal
        })
        .catch((cause: unknown) => {
          throw new ConnectionFailure(cause)
        })
      return { socket, events: socket.events[Symbol.asyncIterator]() }
    }
    try {
      connection ??= await connect()
      if (next !== NEXT_REQUEST.automatic) {
        const { stream: _, ...body } = payload
        if (next === NEXT_REQUEST.required && responseId !== undefined) {
          const input = additionalInput
          if (!input.some((item) => item.type === RESPONSE_ITEM_TYPE.functionCallOutput))
            throw new OpenAiResponsesProviderError("Steering continuation requires tool output")
          connection.socket.send({
            type: "response.create",
            ...body,
            previous_response_id: responseId,
            input
          })
        } else
          connection.socket.send({
            type: "response.create",
            ...body,
            ...(delta === undefined || previous === undefined
              ? {}
              : {
                  previous_response_id: previous.responseId,
                  input: delta
                })
          })
      }
      next = NEXT_REQUEST.create
      priorInput = payload.input
      while (true) {
        if (pollFailure !== undefined) throw pollFailure.cause
        const deadline = abortAfter(options.idleTimeoutMs)
        const read = await (async () => {
          try {
            if (saved !== undefined) return { done: false, value: saved }
            return await raceAbort(
              connection.events.next(),
              AbortSignal.any([signal, deadline.signal])
            )
          } catch (cause) {
            if (deadline.signal.aborted && !signal.aborted)
              throw new RetryableProviderError("OpenAI WebSocket response stream timed out")
            throw cause
          } finally {
            deadline.cancel()
          }
        })()
        saved = undefined
        if (read.done)
          throw new RetryableProviderError(
            "OpenAI WebSocket disconnected before response completion"
          )
        const event = asRecord(read.value)
        if (event === null || typeof event.type !== "string")
          throw new OpenAiResponsesProviderError("Invalid OpenAI WebSocket event")
        if (event.type.startsWith("response.") && event.type !== RESPONSE_EVENT_TYPE.created)
          progressed = true
        if (
          event.type === RESPONSE_EVENT_TYPE.error &&
          responseCode(event) === RESPONSE_ERROR_CODE.nativeTurnContextMismatch &&
          isPortable(capabilities) &&
          !automatic &&
          !progressed &&
          !recoveredRejections.has("context")
        ) {
          recoveredRejections.add("context")
          close()
          yield {
            _tag: "ProviderStreamRetry",
            attempt: 1,
            maxAttempts: 2,
            delayMs: 0,
            reason: "turn context mismatch"
          }
          connection = await connect()
          const { stream: _, ...body } = payload
          connection.socket.send({ type: "response.create", ...body })
          priorInput = payload.input
          continue
        }
        if (
          event.type === RESPONSE_EVENT_TYPE.error &&
          responseCode(event) === RESPONSE_ERROR_CODE.previousResponseNotFound &&
          delta !== undefined &&
          !progressed &&
          !recoveredRejections.has("missing")
        ) {
          recoveredRejections.add("missing")
          previous = undefined
          const { stream: _, ...body } = payload
          connection.socket.send({ type: "response.create", ...body })
          continue
        }
        if (event.type === RESPONSE_EVENT_TYPE.error && isResponseErrorCode(responseCode(event)))
          throw new OpenAiResponsesProviderError(responseFailureMessage(event))
        if (event.type === RESPONSE_EVENT_TYPE.created) {
          if (terminal !== undefined) {
            saved = event
            next = NEXT_REQUEST.automatic
            yield { ...terminal, continuation: true }
            return
          }
          const response = asRecord(event.response)
          if (typeof response?.id !== "string")
            throw new OpenAiResponsesProviderError("Missing OpenAI response identity")
          responseId = response.id
          if (automatic || pending?.kind === STEER.accepted) {
            pending = undefined
            steeredInput = []
          }
          generating = true
          if (carry.length > 0) {
            pending = { kind: STEER.submitted, target: responseId }
            steeredInput = carry
            connection.socket.send({
              type: "response.steer",
              previous_response_id: responseId,
              input: carry
            })
          } else poll()
        }
        if (event.type === RESPONSE_EVENT_TYPE.steerAccepted) {
          const steer = asRecord(event.steer)
          if (
            pending === undefined ||
            steer?.previous_response_id !== pending.target ||
            typeof steer.id !== "string"
          ) {
            throw new OpenAiResponsesProviderError("Unexpected steering acknowledgement")
          }
          pending = { kind: STEER.accepted, target: pending.target, id: steer.id }
          continue
        }
        if (event.type === RESPONSE_EVENT_TYPE.steerFailed) {
          pending = undefined
          failedSteer = true
          if (terminal !== undefined) {
            yield { ...terminal, continuation: true }
            return
          }
          continue
        }
        if (event.type === RESPONSE_EVENT_TYPE.steerPending) {
          if (terminal === undefined)
            throw new OpenAiResponsesProviderError("Steering pending without a completed response")
          next = NEXT_REQUEST.required
          yield { ...terminal, continuation: true }
          return
        }
        const isTerminal =
          event.type === RESPONSE_EVENT_TYPE.completed ||
          event.type === RESPONSE_EVENT_TYPE.incomplete
        if (isTerminal) {
          generating = false
          await pollWork
          terminalRaw = event
        }
        const steered = incompleteReason(event) === INCOMPLETE_REASON.steered
        const mapped =
          event.type === RESPONSE_EVENT_TYPE.incomplete && steered
            ? map({ ...event, type: RESPONSE_EVENT_TYPE.completed })
            : map(event)
        for (const item of mapped) {
          if (isCompletionResponse(item)) terminal = item
          else {
            yield item
          }
        }
        if (terminal !== undefined && pending === undefined) {
          if (terminalRaw?.type === RESPONSE_EVENT_TYPE.incomplete && steered) {
            throw new OpenAiResponsesProviderError("Steered response has no tracked steering input")
          }
          const completedId = asRecord(terminalRaw?.response)?.id
          previous =
            terminalRaw?.type === RESPONSE_EVENT_TYPE.completed &&
            typeof completedId === "string" &&
            capabilities.steering !== STEERING_MODE.native
              ? responseContinuation({
                  payload,
                  message: terminal.message,
                  responseId: completedId,
                  asyncTools: new Set(
                    [...request.tools, ...request.deferredTools].flatMap((tool) =>
                      tool.async === true ? [tool.name] : []
                    )
                  )
                })
              : undefined
          yield deferredOutputs || failedSteer ? { ...terminal, continuation: true } : terminal
          return
        }
      }
    } catch (cause) {
      close()
      throw cause
    } finally {
      generating = false
      timer.cancel()
      await pollWork
      signal.removeEventListener("abort", onAbort)
    }
  }
  return {
    close: () => {
      lifetime.abort()
      close()
    },
    stream: async function* (request): AsyncGenerator<ModelStreamItem> {
      if (options.transport(request.model) !== RESPONSES_TRANSPORT.websocket || socketUnavailable) {
        close()
        yield* await options.fallback(request)
        return
      }
      const signal = AbortSignal.any([
        lifetime.signal,
        ...(request.signal === undefined ? [] : [request.signal])
      ])
      const recoveredRejections = new Set<"context" | "missing">()
      let authRetried = false
      let forceRefresh = false
      for (let attempt = 1; ; attempt++) {
        signal.throwIfAborted()
        const capabilities = await options.capabilities(request.model)
        const boundary = next === NEXT_REQUEST.create && pending === undefined
        const portable = isPortable(capabilities)
        try {
          const refresh = forceRefresh
          forceRefresh = false
          yield* streamAttempt(request, recoveredRejections, refresh)
          return
        } catch (failure) {
          const cause = failure instanceof ConnectionFailure ? failure.cause : failure
          if (signal.aborted || !boundary || (!portable && !(failure instanceof ConnectionFailure)))
            throw cause
          if (
            !authRetried &&
            failure instanceof ConnectionFailure &&
            cause instanceof HttpStatusError &&
            cause.status === 401
          ) {
            authRetried = true
            forceRefresh = true
            attempt--
            continue
          }
          if (!isRetryableFailure(cause)) throw cause
          const delayMs = nextRetry(attempt, cause, { maxAttempts: options.maxAttempts })
          if (delayMs === undefined) {
            const fallbackDelayMs =
              cause instanceof HttpStatusError &&
              (cause.retryAfter !== null || cause.retryAfterMs !== null)
                ? retryDelayMs(attempt, cause)
                : 0
            socketUnavailable = true
            yield {
              _tag: "ProviderStreamRetry",
              attempt,
              maxAttempts: options.maxAttempts + 1,
              delayMs: fallbackDelayMs,
              reason: `${errorMessage(cause, "WebSocket failed")}; falling back to HTTP`
            }
            if (fallbackDelayMs > 0) await backoffSleep(fallbackDelayMs, signal)
            signal.throwIfAborted()
            yield* await options.fallback(request)
            return
          }
          yield {
            _tag: "ProviderStreamRetry",
            attempt,
            maxAttempts: options.maxAttempts,
            delayMs,
            reason: errorMessage(cause, "WebSocket failed")
          }
          await backoffSleep(delayMs, signal)
        }
      }
    }
  }
}

class ConnectionFailure extends Error {
  constructor(cause: unknown) {
    super("OpenAI WebSocket connection failed", { cause })
  }
}
