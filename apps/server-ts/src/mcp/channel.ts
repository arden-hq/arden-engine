import type {
  FetchLike,
  Transport,
  TransportSendOptions
} from "@modelcontextprotocol/sdk/shared/transport.js"
import {
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type MessageExtraInfo
} from "@modelcontextprotocol/sdk/types.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { JsonValue } from "@arden-hq/protocol"
import { Predicate } from "effect"

import {
  decodeStreamSignal,
  EVENTS_PROTOCOL_VERSION,
  isStatelessParams,
  statelessDiscovery,
  statelessParams,
  subscriptionIdOf,
  type McpEventError,
  type McpStreamSignal
} from "./events/wire.js"

const OWN_ID_PREFIX = "arden-mcp-"

const DISCOVER_TIMEOUT_MS = 5_000

const INTERNAL_ERROR = -32_603
const METHOD_NOT_FOUND = -32_601
const INVALID_REQUEST = -32_600

/**
 * What an older server answers `server/discover` with: it does not know the
 * method or its `_meta`, or it wants a session first (the SDK's own servers
 * answer -32000 "No valid session ID"). Only these move a connection to
 * `initialize`, as in Codex's fallback; anything else fails the connection.
 */
const OLDER_SERVER_CODES: ReadonlySet<number> = new Set([
  METHOD_NOT_FOUND,
  INVALID_REQUEST,
  -32_602,
  -32_000
])

/** Requests that carry `params.name` in `Mcp-Name` over HTTP (SEP-2243, SEP-3415). */
const NAMED_METHODS = new Set([
  "tools/call",
  "prompts/get",
  "events/poll",
  "events/stream",
  "events/subscribe",
  "events/unsubscribe"
])

export class McpEventRequestError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "McpEventRequestError"
  }
}

type Lifecycle = "session" | "stateless"

interface PendingRequest {
  readonly resolve: (result: unknown) => void
  readonly reject: (error: McpEventRequestError) => void
}

const textEncoder = new TextEncoder()

export interface McpChannelTransport {
  onclose?: (() => void) | undefined
  onerror?: ((error: Error) => void) | undefined
  onmessage?: ((message: JSONRPCMessage, extra?: MessageExtraInfo) => void) | undefined
  start(): Promise<void>
  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>
  close(): Promise<void>
}

export type McpEventStreamEnd =
  | { readonly kind: "ended" }
  | { readonly kind: "refused"; readonly error: McpEventError }

export interface McpEventStreamRequest {
  readonly name: string
  readonly arguments: Readonly<Record<string, JsonValue>>
  readonly cursor: string | undefined
  readonly maxAgeMs: number
}

export interface McpEventStreamHandlers {
  readonly onSignal: (signal: McpStreamSignal) => void
  readonly onEnd: (end: McpEventStreamEnd) => void
}

export interface McpEventStream {
  readonly cancel: () => void
}

/**
 * One MCP connection's lifecycle, between the SDK client and its transport.
 * When the SDK client connects over HTTP, the channel first asks
 * `server/discover`: a server that offers protocol 2026-07-28 is spoken to
 * statelessly from then on, and the SDK client is answered its `initialize`
 * from the discovery. Any other server (and every stdio one) keeps the
 * `initialize` session, as the SDK runs it. One lifecycle serves the whole
 * connection: tools, and, where the server offers them, events.
 *
 * On the stateless lifecycle every request carries the version and Arden's
 * capabilities in `_meta`, and over HTTP the matching `MCP-Protocol-Version`,
 * `Mcp-Method` and `Mcp-Name` headers and no session id; the transport's
 * authorization still applies. A refusal comes back as a JSON-RPC error the
 * SDK can route, and a cancelled request's fetch is aborted.
 *
 * The channel also owns its own requests (`server/discover`, `events/*`) under
 * its own ids, and routes each `notifications/events/*` message to the push
 * stream it names. A stream is the SSE response to its own POST; cancelling it
 * aborts that fetch, and its body then ends with a result for its id, so the
 * SDK never tries to resume it.
 */
export class McpChannel {
  onclose?: NonNullable<Transport["onclose"]>
  onerror?: NonNullable<Transport["onerror"]>
  onmessage?: NonNullable<Transport["onmessage"]>

  private lifecycle: Lifecycle = "session"
  private eventsOffered = false
  private closed = false
  private nextId = 1
  private readonly streams = new Map<string, McpEventStreamHandlers>()
  private readonly requests = new Map<string, PendingRequest>()
  private readonly fetches = new Map<string, AbortController>()
  private readonly unfetched = new Set<string>()
  private readonly cancelledBeforeFetch = new Set<string>()

  private attached: McpChannelTransport | undefined

  constructor(private readonly delivery: "http" | "stdio") {}

  attach(inner: McpChannelTransport): this {
    inner.onmessage = (message, extra) => this.receive(message, extra)
    inner.onclose = () => {
      this.closed = true
      this.endAll()
      this.onclose?.()
    }
    inner.onerror = (error) => this.onerror?.(error)
    this.attached = inner
    return this
  }

  private get inner(): McpChannelTransport {
    if (this.attached === undefined) throw new Error("MCP event channel has no transport")
    return this.attached
  }

  get offersEvents(): boolean {
    return this.eventsOffered
  }

  request(
    method: string,
    params: Readonly<Record<string, unknown>>,
    options: { readonly timeoutMs: number; readonly signal?: AbortSignal }
  ): Promise<unknown> {
    if (!this.eventsOffered) {
      return Promise.reject(new McpEventRequestError("MCP server offers no events", undefined))
    }
    return this.sendOwn(method, params, options.timeoutMs, options.signal)
  }

  private sendOwn(
    method: string,
    params: Readonly<Record<string, unknown>>,
    timeoutMs: number,
    signal: AbortSignal | undefined
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new McpEventRequestError(`MCP ${method} failed: closed`, undefined))
    }
    const id = `${OWN_ID_PREFIX}${this.nextId++}`
    return new Promise<unknown>((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", aborted)
        this.requests.delete(id)
      }
      const fail = (error: McpEventRequestError) => {
        settle()
        reject(error)
      }
      const aborted = () => fail(new McpEventRequestError(`MCP ${method} was cancelled`, undefined))
      const timer = setTimeout(
        () => fail(new McpEventRequestError(`MCP ${method} timed out`, undefined)),
        timeoutMs
      )
      if (signal?.aborted === true) {
        aborted()
        return
      }
      signal?.addEventListener("abort", aborted, { once: true })
      this.requests.set(id, {
        resolve: (result) => {
          settle()
          resolve(result)
        },
        reject: fail
      })
      this.inner
        .send({
          jsonrpc: "2.0",
          id,
          method,
          params: statelessParams(params)
        })
        .catch((cause: unknown) =>
          fail(new McpEventRequestError(`MCP ${method} failed`, undefined, { cause }))
        )
    })
  }

  get sessionId(): string | undefined {
    return this.attached instanceof StreamableHTTPClientTransport
      ? this.attached.sessionId
      : undefined
  }

  start(): Promise<void> {
    return this.inner.start()
  }

  close(): Promise<void> {
    return this.inner.close()
  }

  setProtocolVersion(version: string): void {
    const inner = this.inner
    if (inner instanceof StreamableHTTPClientTransport) inner.setProtocolVersion(version)
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    if (this.delivery === "http" && isJSONRPCRequest(message) && message.method === "initialize") {
      return this.initialize(message, options)
    }
    if (this.lifecycle === "session") return this.inner.send(message, options)
    if (isJSONRPCRequest(message)) {
      const key = String(message.id)
      this.unfetched.add(key)
      return this.inner
        .send({ ...message, params: statelessParams(message.params ?? {}) }, options)
        .finally(() => this.forgetUnfetched(key))
    }
    if (isJSONRPCNotification(message)) {
      if (message.method === "notifications/cancelled") {
        const requestId = message.params?.["requestId"]
        if (typeof requestId === "string" || typeof requestId === "number") {
          this.abortFetch(String(requestId))
        }
      }
      return Promise.resolve()
    }
    return this.inner.send(message, options)
  }

  private async initialize(
    message: Extract<JSONRPCMessage, { method: string; id: string | number }>,
    options: TransportSendOptions | undefined
  ): Promise<void> {
    const discovered = await this.sendOwn("server/discover", {}, DISCOVER_TIMEOUT_MS, undefined)
      .then((result) => statelessDiscovery(result, message.params?.["protocolVersion"]))
      .catch((cause: unknown) => {
        if (!(cause instanceof McpEventRequestError)) throw cause
        if (cause.code !== undefined && OLDER_SERVER_CODES.has(cause.code)) return undefined
        throw cause.code === undefined && cause.cause !== undefined ? cause.cause : cause
      })
    if (discovered === undefined) return this.inner.send(message, options)
    this.lifecycle = "stateless"
    this.eventsOffered = discovered.events
    queueMicrotask(() =>
      this.onmessage?.({ jsonrpc: "2.0", id: message.id, result: discovered.initialize })
    )
  }

  openStream(request: McpEventStreamRequest, handlers: McpEventStreamHandlers): McpEventStream {
    const id = `${OWN_ID_PREFIX}${this.nextId++}`
    const cancel = () => this.cancel(id)
    if (this.closed) {
      handlers.onEnd({ kind: "ended" })
      return { cancel }
    }
    this.streams.set(id, handlers)
    this.unfetched.add(id)
    this.inner
      .send({
        jsonrpc: "2.0",
        id,
        method: "events/stream",
        params: statelessParams({
          name: request.name,
          arguments: request.arguments,
          cursor: request.cursor ?? null,
          maxAgeMs: request.maxAgeMs
        })
      })
      .catch(() => this.finish(id, { kind: "ended" }))
      .finally(() => this.forgetUnfetched(id))
    return { cancel }
  }

  /**
   * Wraps an HTTP transport's fetch. A stateless request goes out with its
   * headers and no session id, can be aborted on its own, and its refusal comes
   * back as a JSON-RPC error the SDK can route. A push stream's body always
   * ends with a result for its id; any other answer's body ends quietly when
   * its request is cancelled.
   */
  wrapFetch(fetch: FetchLike): FetchLike {
    return async (url, init) => {
      const request = statelessRequest(init?.body)
      if (request === undefined) return fetch(url, init)
      const key = String(request.id)
      const abort = new AbortController()
      this.fetches.set(key, abort)
      this.unfetched.delete(key)
      if (this.cancelledBeforeFetch.delete(key)) abort.abort()
      const signal =
        init?.signal === undefined || init.signal === null
          ? abort.signal
          : AbortSignal.any([init.signal, abort.signal])
      const ended = () => {
        this.fetches.delete(key)
        this.finish(key, { kind: "ended" })
      }
      try {
        const response = await statelessResponse(
          await fetch(url, { ...init, signal, headers: statelessHeaders(init?.headers, request) }),
          request.id
        )
        const eventStream = response.headers.get("content-type")?.includes("text/event-stream")
        if (response.body === null || eventStream !== true) {
          this.fetches.delete(key)
          return response
        }
        const result = this.streams.has(key)
          ? `\n\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: key, result: {} })}\n\n`
          : undefined
        return new Response(endWith(response.body, result, ended), response)
      } catch (cause) {
        this.fetches.delete(key)
        if (abort.signal.aborted && init?.signal?.aborted !== true) {
          return new Response(null, { status: 202 })
        }
        throw cause
      }
    }
  }

  private abortFetch(key: string): void {
    const fetch = this.fetches.get(key)
    if (fetch !== undefined) fetch.abort()
    else if (this.unfetched.has(key)) this.cancelledBeforeFetch.add(key)
  }

  private forgetUnfetched(key: string): void {
    this.unfetched.delete(key)
    this.cancelledBeforeFetch.delete(key)
  }

  private cancel(id: string): void {
    if (this.streams.delete(id)) this.abortFetch(id)
  }

  private finish(id: string, end: McpEventStreamEnd): void {
    const stream = this.streams.get(id)
    if (stream === undefined) return
    this.streams.delete(id)
    stream.onEnd(end)
  }

  private endAll(): void {
    const open = [...this.streams.keys()]
    for (const id of open) this.finish(id, { kind: "ended" })
    for (const fetch of this.fetches.values()) fetch.abort()
    for (const request of [...this.requests.values()]) {
      request.reject(new McpEventRequestError("MCP connection closed", undefined))
    }
  }

  private receive(message: JSONRPCMessage, extra?: MessageExtraInfo): void {
    if (isJSONRPCNotification(message) && message.method.startsWith("notifications/events/")) {
      const id = subscriptionIdOf(message.params)
      const stream = id === undefined ? undefined : this.streams.get(String(id))
      const signal = decodeStreamSignal(message.method, message.params)
      if (stream !== undefined && signal !== undefined) stream.onSignal(signal)
      return
    }
    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
      if (typeof message.id === "string" && message.id.startsWith(OWN_ID_PREFIX)) {
        const request = this.requests.get(message.id)
        if (request !== undefined) {
          if (isJSONRPCResultResponse(message)) request.resolve(message.result)
          else {
            request.reject(new McpEventRequestError(message.error.message, message.error.code))
          }
          return
        }
        this.finish(
          message.id,
          isJSONRPCErrorResponse(message)
            ? {
                kind: "refused",
                error: { code: message.error.code, message: message.error.message }
              }
            : { kind: "ended" }
        )
        return
      }
    }
    this.onmessage?.(message, extra)
  }
}

interface StatelessRequest {
  readonly id: string | number
  readonly method: string
  readonly name: string | undefined
}

const statelessRequest = (body: RequestInit["body"]): StatelessRequest | undefined => {
  if (typeof body !== "string" || !body.includes(EVENTS_PROTOCOL_VERSION)) return undefined
  const message: unknown = JSON.parse(body)
  if (!Predicate.isObject(message)) return undefined
  const { id, method, params } = message
  if ((typeof id !== "string" && typeof id !== "number") || typeof method !== "string") {
    return undefined
  }
  if (!isStatelessParams(params)) return undefined
  const name = Predicate.isObject(params) ? params["name"] : undefined
  return { id, method, name: typeof name === "string" ? name : undefined }
}

const statelessHeaders = (headers: RequestInit["headers"], own: StatelessRequest): Headers => {
  const merged = new Headers(headers)
  merged.delete("mcp-session-id")
  merged.set("mcp-protocol-version", EVENTS_PROTOCOL_VERSION)
  merged.set("mcp-method", own.method)
  if (NAMED_METHODS.has(own.method) && own.name !== undefined) {
    merged.set("mcp-name", headerName(own.name))
  }
  return merged
}

const headerName = (name: string): string =>
  /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(name) && !name.startsWith("=?base64?")
    ? name
    : `=?base64?${Buffer.from(name, "utf8").toString("base64")}?=`

const authorizationChallenge = (response: Response): boolean =>
  response.status === 401 ||
  (response.status === 403 &&
    response.headers.get("www-authenticate")?.includes("insufficient_scope") === true)

/** A refusal's JSON-RPC code when its body has none, by its HTTP status. */
const refusalCode = (status: number): number => {
  if (status === 404 || status === 405) return METHOD_NOT_FOUND
  if (status === 400) return INVALID_REQUEST
  return INTERNAL_ERROR
}

/**
 * A stateless answer as the SDK should see it. A refusal (HTTP 4xx/5xx other
 * than an authorization challenge) becomes a JSON-RPC error for the request's
 * id, carrying the server's code when its body has one, else method-not-found
 * for a 4xx and an internal error for a 5xx; a session id the answer names is
 * not this lifecycle's.
 */
const statelessResponse = async (response: Response, id: string | number): Promise<Response> => {
  if (response.ok || authorizationChallenge(response)) {
    if (!response.headers.has("mcp-session-id")) return response
    const headers = new Headers(response.headers)
    headers.delete("mcp-session-id")
    return new Response(response.body, { status: response.status, headers })
  }
  const body: unknown = await response.json().catch(() => undefined)
  const error =
    Predicate.isObject(body) && Predicate.isObject(body["error"]) ? body["error"] : undefined
  const statusCode = refusalCode(response.status)
  const code = error !== undefined && typeof error["code"] === "number" ? error["code"] : statusCode
  const message =
    error !== undefined && typeof error["message"] === "string"
      ? error["message"]
      : `HTTP ${response.status}`
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } })
}

const endWith = (
  body: ReadableStream<Uint8Array>,
  result: string | undefined,
  onEnd: () => void
): ReadableStream<Uint8Array> => {
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read().catch(() => undefined)
      if (next !== undefined && !next.done) {
        controller.enqueue(next.value)
        return
      }
      if (result !== undefined) controller.enqueue(textEncoder.encode(result))
      controller.close()
      onEnd()
    },
    cancel(reason) {
      onEnd()
      return reader.cancel(reason)
    }
  })
}
