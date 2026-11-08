import type { Metadata } from "../../contracts/messages.js"
import type {
  ModelProvider,
  ModelProviderSession,
  ModelStreamItem,
  CompletionResponse,
  ModelProviderRequest
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
import { OpenAiResponsesProviderError } from "./errors.js"
import { asRecord, type RawResponseEvent } from "./items.js"
import { makePayload } from "./request.js"
import { makeEventMapper, responseCode, responseFailureMessage } from "./response.js"
import {
  incrementalInput,
  responseContinuation,
  type ResponseContinuation
} from "./continuation.js"

/** Hosts supply the platform socket and authentication headers; Loop owns the protocol. */
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
  readonly modelPrefix: string
  readonly defaultInstructions?: string
  readonly omitMaxOutputTokens?: boolean
  readonly maxAttempts: number
  readonly idleTimeoutMs: number
  readonly capabilities: NonNullable<ModelProvider["capabilities"]>
  readonly transport: (model: string) => "sse" | "websocket"
  readonly cacheScopeHeader?: string
  readonly fallback: ModelProvider["stream"]
}): ModelProviderSession => {
  const lifetime = new AbortController()
  let connection:
    | { readonly socket: ResponsesWebSocket; readonly events: AsyncIterator<unknown> }
    | undefined
  let saved: RawResponseEvent | undefined
  let next: "create" | "automatic" | "required" = "create"
  let responseId: string | undefined
  let priorInput: ReadonlyArray<Metadata> = []
  let steeredInput: ReadonlyArray<Metadata> = []
  let pending:
    | { readonly kind: "submitted"; readonly target: string }
    | { readonly kind: "accepted"; readonly target: string; readonly id: string }
    | undefined
  let route: { readonly model: string; readonly cacheScope: string | undefined } | undefined
  let previous: ResponseContinuation | undefined
  let socketUnavailable = false

  const close = () => {
    connection?.socket.close()
    connection = undefined
    saved = undefined
    pending = undefined
    next = "create"
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
    if (
      capabilities.steering !== "native" &&
      capabilities.asyncTools !== "native" &&
      connection?.socket.isClosed()
    )
      close()
    route = { model: request.model, cacheScope: request.cacheScope }
    const signal = AbortSignal.any([
      lifetime.signal,
      ...(request.signal === undefined ? [] : [request.signal])
    ])
    const requestPayload =
      options.omitMaxOutputTokens === true
        ? (({ maxOutputTokens: _, ...rest }) => rest)(request)
        : request
    const payload = makePayload(requestPayload, options.modelPrefix, options.defaultInstructions)
    const delta =
      capabilities.steering === "native" || previous === undefined
        ? undefined
        : incrementalInput(payload, previous)
    const additionalInput = continuationInput(payload.input, priorInput, steeredInput)
    const automatic = next === "automatic"
    const carry = automatic ? additionalInput.filter((item) => item.role === "user") : []
    const deferredOutputs =
      automatic && additionalInput.some((item) => item.type === "function_call_output")
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
    const map = makeEventMapper(request.model, request.toolSearch)
    let pollWork = Promise.resolve()
    const poll = () => {
      if (
        capabilities.steering !== "native" ||
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
        pending = { kind: "submitted", target }
        const input = makePayload(
          { ...request, messages, tools: [], deferredTools: [] },
          options.modelPrefix,
          undefined
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
    const timer = setInterval(poll, 100)
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
      if (next !== "automatic") {
        const { stream: _, ...body } = payload
        if (next === "required" && responseId !== undefined) {
          const input = additionalInput
          if (!input.some((item) => item.type === "function_call_output"))
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
      next = "create"
      priorInput = payload.input
      while (true) {
        if (pollFailure !== undefined) throw pollFailure.cause
        const deadline = new AbortController()
        const timer = setTimeout(() => deadline.abort(), options.idleTimeoutMs)
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
            clearTimeout(timer)
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
        if (event.type.startsWith("response.") && event.type !== "response.created")
          progressed = true
        if (
          event.type === "error" &&
          responseCode(event) === "native_turn_context_mismatch" &&
          capabilities.steering !== "native" &&
          capabilities.asyncTools !== "native" &&
          !automatic &&
          !progressed &&
          !recoveredRejections.has("context")
        ) {
          recoveredRejections.add("context")
          close()
          yield { _tag: "ProviderStreamRetry", attempt: 1, maxAttempts: 2, delayMs: 0 }
          connection = await connect()
          const { stream: _, ...body } = payload
          connection.socket.send({ type: "response.create", ...body })
          priorInput = payload.input
          continue
        }
        if (
          event.type === "error" &&
          responseCode(event) === "previous_response_not_found" &&
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
        if (
          event.type === "error" &&
          ["native_turn_context_mismatch", "previous_response_not_found"].includes(
            responseCode(event) ?? ""
          )
        )
          throw new OpenAiResponsesProviderError(responseFailureMessage(event))
        if (event.type === "response.created") {
          if (terminal !== undefined) {
            saved = event
            next = "automatic"
            yield { ...terminal, continuation: true }
            return
          }
          const response = asRecord(event.response)
          if (typeof response?.id !== "string")
            throw new OpenAiResponsesProviderError("Missing OpenAI response identity")
          responseId = response.id
          if (automatic || pending?.kind === "accepted") {
            pending = undefined
            steeredInput = []
          }
          generating = true
          if (carry.length > 0) {
            pending = { kind: "submitted", target: responseId }
            steeredInput = carry
            connection.socket.send({
              type: "response.steer",
              previous_response_id: responseId,
              input: carry
            })
          } else poll()
        }
        if (event.type === "response.steer.accepted") {
          const steer = asRecord(event.steer)
          if (
            pending === undefined ||
            steer?.previous_response_id !== pending.target ||
            typeof steer.id !== "string"
          ) {
            throw new OpenAiResponsesProviderError("Unexpected steering acknowledgement")
          }
          pending = { kind: "accepted", target: pending.target, id: steer.id }
          continue
        }
        if (event.type === "response.steer.failed") {
          pending = undefined
          failedSteer = true
          if (terminal !== undefined) {
            yield { ...terminal, continuation: true }
            return
          }
          continue
        }
        if (event.type === "response.steer.pending") {
          if (terminal === undefined)
            throw new OpenAiResponsesProviderError("Steering pending without a completed response")
          next = "required"
          yield { ...terminal, continuation: true }
          return
        }
        const isTerminal =
          event.type === "response.completed" || event.type === "response.incomplete"
        if (isTerminal) {
          generating = false
          await pollWork
          terminalRaw = event
        }
        const details = asRecord(asRecord(event.response)?.incomplete_details)
        const mapped =
          event.type === "response.incomplete" && details?.reason === "steered"
            ? map({ ...event, type: "response.completed" })
            : map(event)
        for (const item of mapped) {
          if (item._tag === "Completed") terminal = item
          else {
            yield item
          }
        }
        if (terminal !== undefined && pending === undefined) {
          if (terminalRaw?.type === "response.incomplete" && details?.reason === "steered") {
            throw new OpenAiResponsesProviderError("Steered response has no tracked steering input")
          }
          const completedId = asRecord(terminalRaw?.response)?.id
          previous =
            terminalRaw?.type === "response.completed" &&
            typeof completedId === "string" &&
            capabilities.steering !== "native"
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
      clearInterval(timer)
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
      if (options.transport(request.model) !== "websocket" || socketUnavailable) {
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
        const boundary = next === "create" && pending === undefined
        const portable = capabilities.steering !== "native" && capabilities.asyncTools !== "native"
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
              delayMs: fallbackDelayMs
            }
            if (fallbackDelayMs > 0) await backoffSleep(fallbackDelayMs, signal)
            signal.throwIfAborted()
            yield* await options.fallback(request)
            return
          }
          yield { _tag: "ProviderStreamRetry", attempt, maxAttempts: options.maxAttempts, delayMs }
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

const continuationInput = (
  input: ReadonlyArray<Metadata>,
  previous: ReadonlyArray<Metadata>,
  steered: ReadonlyArray<Metadata>
): ReadonlyArray<Metadata> => {
  const seen = new Map<string, number>()
  for (const item of [...previous, ...steered]) {
    const key = JSON.stringify(item)
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  return input.filter((item) => {
    if (item.role !== "user" && item.type !== "function_call_output") return false
    const key = JSON.stringify(item)
    const count = seen.get(key) ?? 0
    if (count === 0) return true
    seen.set(key, count - 1)
    return false
  })
}
