import { errorMessage, redactedFailureText } from "@arden-hq/std/errors"
import { retryAfterHints } from "@arden-hq/std/retry"
import { abortAfter } from "@arden-hq/std/timer"

import { isCompletionResponse, type ModelStreamItem } from "../../contracts/provider.js"
import type { ProviderErrorCode } from "../../errors.js"
import { raceAbort } from "../../abort.js"
import { HttpStatusError, ProviderError, RetryableProviderError } from "./errors.js"
import { ProviderStatusError } from "./rejection.js"
import { backoffSleep, nextRetry } from "./retry.js"
import { readSseEvents, type SseEvent, SseParser } from "./sse.js"

export interface ProviderAuthHeadersOptions {
  readonly signal: AbortSignal
  readonly forceRefresh?: boolean
}

export interface ProviderAuth {
  readonly headers: (options: ProviderAuthHeadersOptions) => Promise<Record<string, string>>
}

export type ProviderErrorClass = new (message: string, code?: ProviderErrorCode) => ProviderError

const MAX_ERROR_DETAIL_BYTES = 16_384
const MAX_ERROR_DETAIL_WAIT_MS = 5_000

export const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("The model request was cancelled", "AbortError")

export const providerAuthHeaders = async (options: {
  readonly auth: ProviderAuth
  readonly signal: AbortSignal | undefined
  readonly forceRefresh: boolean
  readonly errorClass: ProviderErrorClass
}): Promise<Record<string, string>> => {
  const { signal } = options
  try {
    signal?.throwIfAborted()
    const headers = await options.auth.headers({
      signal: signal ?? new AbortController().signal,
      ...(options.forceRefresh ? { forceRefresh: true } : {})
    })
    signal?.throwIfAborted()
    return headers
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal)
    if (error instanceof options.errorClass) throw error
    throw new options.errorClass("The account could not provide credentials", "provider_auth")
  }
}

export interface SseEventMapper {
  readonly event: (event: SseEvent) => ReadonlyArray<ModelStreamItem>
  readonly end: () => ReadonlyArray<ModelStreamItem>
}

export interface SseRequest {
  readonly url: string
  readonly body: string
  readonly fetch: typeof globalThis.fetch
  readonly auth: ProviderAuth | undefined
  readonly headers: Readonly<Record<string, string>>
  readonly idleTimeoutMs: number
  readonly maxAttempts: number
  readonly signal: AbortSignal | undefined
  readonly label: string
  readonly errorClass: ProviderErrorClass
  readonly classifyStatus: (status: number, detail: string | undefined) => ProviderErrorCode
  readonly mapper: () => SseEventMapper
}

export const streamSse = async function* (request: SseRequest): AsyncGenerator<ModelStreamItem> {
  let forceRefresh = false
  let authRetried = false
  let attempts = 0

  while (true) {
    attempts += 1
    let emitted = false
    const headers = {
      ...(request.auth === undefined
        ? {}
        : await providerAuthHeaders({
            auth: request.auth,
            signal: request.signal,
            forceRefresh,
            errorClass: request.errorClass
          })),
      ...request.headers
    }
    request.signal?.throwIfAborted()
    forceRefresh = false
    const attempt = new AbortController()
    const signal = request.signal
    const propagateAbort = (): void => {
      if (signal !== undefined) attempt.abort(abortReason(signal))
    }
    signal?.addEventListener("abort", propagateAbort, { once: true })
    const parser = new SseParser()
    const mapper = request.mapper()
    try {
      const body = await connect(request, headers, attempt.signal)
      for await (const event of readSseEvents(body, parser, {
        idleTimeoutMs: request.idleTimeoutMs,
        streamName: `${request.label} response stream`,
        ...(request.signal === undefined ? {} : { signal: request.signal })
      })) {
        if (request.signal?.aborted) throw abortReason(request.signal)
        for (const item of mapper.event(event)) {
          emitted = true
          yield item
          if (isCompletionResponse(item)) return
        }
      }
      for (const item of mapper.end()) {
        emitted = true
        yield item
        if (isCompletionResponse(item)) return
      }
      throw new RetryableProviderError(
        `${request.label} response stream ended before a terminal event`
      )
    } catch (error) {
      if (request.signal?.aborted) throw abortReason(request.signal)
      attempt.abort()
      if (
        !emitted &&
        !authRetried &&
        request.auth !== undefined &&
        error instanceof HttpStatusError &&
        error.status === 401
      ) {
        authRetried = true
        forceRefresh = true
        attempts -= 1
        continue
      }
      const delayMs = nextRetry(attempts, error, {
        maxAttempts: request.maxAttempts,
        wireHintMs: parser.retryDelayMs
      })
      if (delayMs !== undefined) {
        yield {
          _tag: "ProviderStreamRetry",
          attempt: attempts,
          maxAttempts: request.maxAttempts,
          delayMs,
          reason: errorMessage(error, "Stream failed")
        }
        await waitBeforeRetry(request, delayMs)
        continue
      }
      throw sanitizedFailure(request, error)
    } finally {
      request.signal?.removeEventListener("abort", propagateAbort)
      attempt.abort()
    }
  }
}

const waitBeforeRetry = async (request: SseRequest, delayMs: number): Promise<void> => {
  try {
    await backoffSleep(delayMs, request.signal)
  } catch {
    if (request.signal?.aborted) throw abortReason(request.signal)
    throw new request.errorClass(`${request.label} response retry was interrupted`)
  }
}

const sanitizedFailure = (request: SseRequest, error: unknown): ProviderError => {
  if (error instanceof request.errorClass) return error
  if (error instanceof ProviderError) return new request.errorClass(error.message, error.code)
  return new request.errorClass(`${request.label} response stream failed`)
}

const connect = async (
  request: SseRequest,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<ReadableStream<Uint8Array>> => {
  let response: Response
  try {
    response = await request.fetch(request.url, {
      method: "POST",
      headers: {
        ...headers,
        accept: "text/event-stream",
        "content-type": "application/json"
      },
      body: request.body,
      signal
    })
  } catch (cause) {
    if (signal.aborted) throw cause
    throw new RetryableProviderError(`${request.label}: ${unreachableMessage(request.url, cause)}`)
  }
  if (!response.ok) {
    const { retryAfter, retryAfterMs } = retryAfterHints(response.headers)
    const detail = await readErrorDetail(response.body, signal, request.idleTimeoutMs)
    throw new ProviderStatusError({
      label: request.label,
      status: response.status,
      retryAfter,
      retryAfterMs,
      detail,
      classify: request.classifyStatus
    })
  }
  if (response.body === null)
    throw new RetryableProviderError(`${request.label} returned an empty response body`)
  return response.body
}

export const unreachableMessage = (url: string, cause: unknown): string => {
  const address = URL.canParse(url) ? safeAddress(new URL(url)) : "the server"
  const reasons = causeChain(cause).map((reason) => reason.replaceAll(url, address))
  const [first = "the connection failed", ...rest] = reasons
  return redactedFailureText(
    `cannot reach ${address}: ${first}${rest.length === 0 ? "" : ` (${rest.join("; ")})`}`
  )
}

const safeAddress = (url: URL): string => `${url.origin}${url.pathname}`

const causeChain = (cause: unknown): ReadonlyArray<string> => {
  const messages: Array<string> = []
  let current: unknown = cause
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    const message = errorMessage(current).trim()
    if (message.length > 0 && !messages.includes(message)) messages.push(message)
    current = current instanceof Error ? current.cause : undefined
  }
  return messages
}

const readErrorDetail = async (
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  idleTimeoutMs: number
): Promise<string | undefined> => {
  if (body === null) return undefined
  const reader = body.getReader()
  const timeout = abortAfter(Math.min(idleTimeoutMs, MAX_ERROR_DETAIL_WAIT_MS))
  const readSignal = AbortSignal.any([signal, timeout.signal])
  const decoder = new TextDecoder()
  let detail = ""
  let bytes = 0
  try {
    while (bytes < MAX_ERROR_DETAIL_BYTES) {
      const chunk = await raceAbort(reader.read(), readSignal)
      if (chunk.done) return detail + decoder.decode()
      const available = MAX_ERROR_DETAIL_BYTES - bytes
      const slice = chunk.value.subarray(0, available)
      detail += decoder.decode(slice, { stream: true })
      bytes += slice.byteLength
    }
    return detail + decoder.decode()
  } catch {
    if (signal.aborted) throw abortReason(signal)
    return detail || undefined
  } finally {
    timeout.cancel()
    void reader.cancel().catch(() => {})
  }
}

export const checkTransportOptions = (options: {
  readonly label: string
  readonly idleTimeoutMs: number | undefined
  readonly maxAttempts: number | undefined
  readonly errorClass: ProviderErrorClass
}): void => {
  if (
    options.idleTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.idleTimeoutMs) || options.idleTimeoutMs <= 0)
  ) {
    throw new options.errorClass(`${options.label} idle timeout must be a positive integer`)
  }
  if (
    options.maxAttempts !== undefined &&
    (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts <= 0)
  ) {
    throw new options.errorClass(`${options.label} max attempts must be a positive integer`)
  }
}
