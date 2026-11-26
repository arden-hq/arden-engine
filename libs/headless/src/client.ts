import { parseJsonBody } from "@arden-hq/protocol/common"
import { abortAfter } from "@arden-hq/std/timer"
import type { DecodedServerEventFrame } from "@arden-hq/protocol"
import {
  CHAT_RECEIPT_STATUS,
  chatDecoders,
  chatRequests,
  chatRoutes,
  RECEIPT_RUN,
  SENT_FROM,
  type CancelInput,
  type CancelResponse,
  type ChatDelivery,
  type ChatMessageInput,
  type ChatReceiptStatus,
  type QueuedCancelResponse,
  type QueuedChatMessage,
  type ConnectionResultInput,
  type ToolResultInput
} from "@arden-hq/protocol/chat"
import { spaceDecoders, spaceRoutes, type SpaceListResponse } from "@arden-hq/protocol/spaces"
import { healthDecoders, healthRoutes, type HealthStatus } from "@arden-hq/protocol/health"
import { modelDecoders, modelRoutes, type ModelCatalog } from "@arden-hq/protocol/models"
import { toolDecoders, toolRoutes, type ToolCatalogResponse } from "@arden-hq/protocol/tools"
import { ProtocolError } from "@arden-hq/protocol"
import {
  isTerminalRunStatus,
  runDecoders,
  runEncoders,
  runRoutes,
  type ResolveRunQuestionInput,
  type RunQuestion,
  type RunDetail,
  type RunEventPage,
  type RunList,
  type RunTerminalResult,
  RUN_CLIENT
} from "@arden-hq/protocol/runs"
import {
  sessionDecoders,
  sessionRequests,
  sessionRoutes,
  type BranchSessionRequest,
  type BranchSessionResponse,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type SessionListOptions,
  type SessionListResponse
} from "@arden-hq/protocol/sessions"
import { retryableStatus } from "@arden-hq/std/retry"
import { sleep } from "@arden-hq/std/sleep"
import { listAllRuns, type HeadlessRunListOptions } from "./run-list.js"

export type { ModelCatalog, ResolveRunQuestionInput, RunDetail, RunQuestion, RunTerminalResult }

export type HeadlessRunEvent = DecodedServerEventFrame

export interface HeadlessClientOptions {
  readonly baseUrl: string | URL
  readonly headers?: Readonly<Record<string, string>>
  readonly fetch?: typeof globalThis.fetch
}

export interface SubmittedRun {
  readonly runId: string
  readonly sessionId: string
  readonly clientId: string
  readonly status: ChatReceiptStatus
  readonly delivery: ChatDelivery
}

export interface QueueMessageInput {
  readonly sessionId: string
  readonly message: string
  readonly clientId?: string
}

export interface HeadlessStreamOptions {
  readonly signal?: AbortSignal
}

export interface HeadlessRunEventOptions {
  readonly afterSequence?: number
  readonly limit?: number
  readonly signal?: AbortSignal
}

export interface WaitForRunOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly reconnectDelayMs?: number
  readonly onEvent?: (event: HeadlessRunEvent, signal: AbortSignal) => void | PromiseLike<void>
}

export class HeadlessHttpError extends Error {
  override readonly name = "HeadlessHttpError"

  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly detail: string
  ) {
    super(`${method} ${path} failed with HTTP ${status}${detail.length === 0 ? "" : `: ${detail}`}`)
  }
}

export class HeadlessProtocolError extends Error {
  override readonly name = "HeadlessProtocolError"
  override readonly cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.cause = cause
  }
}

export class HeadlessTimeoutError extends Error {
  override readonly name = "HeadlessTimeoutError"

  constructor(readonly timeoutMs: number) {
    super(`Run did not finish within ${timeoutMs} ms`)
  }
}

export class HeadlessEventHandlerError extends Error {
  override readonly name = "HeadlessEventHandlerError"
  override readonly cause: unknown

  constructor(cause: unknown) {
    super("Headless Run event handler failed")
    this.cause = cause
  }
}

const reconcilingEvents: ReadonlySet<HeadlessRunEvent["data"]["type"]> = new Set([
  "RUN_FINISHED",
  "RUN_ERROR",
  "run_cancelled",
  "stream_snapshot",
  "stream_live"
])

const shouldReconcile = (event: HeadlessRunEvent): boolean => reconcilingEvents.has(event.data.type)

const responseDetail = (response: Response): Promise<string> =>
  response.text().then(
    (body) => body.trim().slice(0, 2_000),
    () => ""
  )

const responseJson = (response: Response): Promise<unknown> =>
  parseJsonBody(response).catch((cause: unknown) => {
    throw new HeadlessProtocolError("Arden returned invalid JSON", cause)
  })

const responseChunks = async function* (
  body: ReadableStream<Uint8Array>
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) return
      yield next.value
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

const retryableConnectionFailure = (cause: unknown): boolean =>
  cause instanceof TypeError ||
  (cause instanceof HeadlessHttpError && retryableStatus(cause.status))

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted !== true) return
  throw signal.reason instanceof Error ? signal.reason : new Error("Headless Run wait was aborted")
}

interface RunIdentity {
  readonly runId: string
  readonly sessionId: string
  readonly clientId: string | null
}

const clientIdOf = (detail: RunDetail): string | null =>
  detail.client.kind === RUN_CLIENT.client ? detail.client.client_id : null

const assertRunIdentity = (detail: RunDetail, submitted: RunIdentity): void => {
  if (detail.run_id !== submitted.runId || detail.session_id !== submitted.sessionId) {
    throw new HeadlessProtocolError("Arden returned a Run that does not match its submission")
  }
  if (clientIdOf(detail) !== submitted.clientId) {
    throw new HeadlessProtocolError("Arden returned a Run with a different client identity")
  }
}

export class HeadlessClient {
  readonly #baseUrl: URL
  readonly #headers: Readonly<Record<string, string>>
  readonly #fetch: typeof globalThis.fetch

  constructor(options: HeadlessClientOptions) {
    this.#baseUrl = new URL(options.baseUrl)
    this.#headers = Object.freeze({ ...(options.headers ?? {}) })
    this.#fetch = options.fetch ?? globalThis.fetch
  }

  async createSession(input: CreateSessionRequest): Promise<CreateSessionResponse> {
    return sessionDecoders.createResponse(
      await this.#requestJson(sessionRoutes.collection, {
        method: "POST",
        body: sessionRequests.create(input)
      })
    )
  }

  async branchSession(
    sessionId: string,
    input: BranchSessionRequest
  ): Promise<BranchSessionResponse> {
    return sessionDecoders.branchResponse(
      await this.#requestJson(sessionRoutes.branch(sessionId), {
        method: "POST",
        body: sessionRequests.branch(input)
      })
    )
  }

  async submit(input: ChatMessageInput): Promise<SubmittedRun> {
    const prepared = chatRequests.message(input)
    let response: Response | undefined
    let lastCause: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await this.#fetch(this.#url(chatRoutes.message), {
          method: "POST",
          headers: this.#requestHeaders(true),
          body: prepared.body
        })
        if (response.ok || !retryableStatus(response.status) || attempt === 1) break
        lastCause = new HeadlessHttpError(
          response.status,
          "POST",
          chatRoutes.message,
          await responseDetail(response)
        )
      } catch (cause) {
        lastCause = cause
        if (attempt === 1) throw cause
      }
    }
    if (response === undefined) throw lastCause
    if (!response.ok) throw await this.#httpError(response, "POST", chatRoutes.message)
    const receipt = chatDecoders.receipt(await responseJson(response))
    if (receipt.run.kind !== RECEIPT_RUN.run) {
      throw new HeadlessProtocolError("Arden accepted no Run for the submitted message")
    }
    return {
      runId: receipt.run.runId,
      sessionId: receipt.sessionId,
      clientId: prepared.clientId,
      status: receipt.status,
      delivery: receipt.delivery
    }
  }

  async queue(input: QueueMessageInput): Promise<QueuedChatMessage> {
    const clientId = input.clientId ?? globalThis.crypto.randomUUID()
    return chatDecoders.queuedMessage(
      await this.#requestJson(chatRoutes.queue(input.sessionId), {
        method: "POST",
        body: chatRequests.enqueue({
          sessionId: input.sessionId,
          clientId,
          message: input.message,
          images: [],
          sentFrom: { kind: SENT_FROM.typed }
        })
      })
    )
  }

  async listQueued(sessionId: string): Promise<ReadonlyArray<QueuedChatMessage>> {
    return chatDecoders.queue(
      await this.#requestJson(chatRoutes.queue(sessionId), { method: "GET" })
    ).messages
  }

  async cancelQueued(sessionId: string, clientId: string): Promise<QueuedCancelResponse> {
    return chatDecoders.queuedCancellation(
      await this.#requestJson(chatRoutes.queuedMessage({ sessionId, clientId }), {
        method: "DELETE"
      })
    )
  }

  async getRun(runId: string): Promise<RunDetail> {
    return this.#getRun(runId)
  }

  async listRuns(options: HeadlessRunListOptions = {}): Promise<RunList> {
    return listAllRuns(options, async (path) =>
      runDecoders.list(await this.#requestJson(path, { method: "GET" }))
    )
  }

  async getRunEvents(runId: string, options: HeadlessRunEventOptions = {}): Promise<RunEventPage> {
    const { signal, afterSequence = 0, limit = 100 } = options
    return runDecoders.eventPage(
      await this.#requestJson(runRoutes.events(runId, { afterSequence, limit }), {
        method: "GET",
        ...(signal === undefined ? {} : { signal })
      })
    )
  }

  async *streamSession(
    sessionId: string,
    options: HeadlessStreamOptions = {}
  ): AsyncGenerator<HeadlessRunEvent> {
    const path = chatRoutes.events(sessionId)
    const response = await this.#fetch(this.#url(path), {
      method: "GET",
      headers: this.#requestHeaders(false, { accept: "text/event-stream" }),
      ...(options.signal === undefined ? {} : { signal: options.signal })
    })
    if (!response.ok) throw await this.#httpError(response, "GET", path)
    if (response.body === null) {
      throw new HeadlessProtocolError("Arden returned an empty event stream")
    }
    yield* chatDecoders.eventStream(responseChunks(response.body))
  }

  async wait(run: SubmittedRun, options: WaitForRunOptions = {}): Promise<RunDetail> {
    if (run.status === CHAT_RECEIPT_STATUS.queued) return this.waitForRun(run.runId, options)
    return this.#waitFor(run, options)
  }

  async waitForRun(runId: string, options: WaitForRunOptions = {}): Promise<RunDetail> {
    const detail = await this.#getRun(runId, options.signal)
    if (isTerminalRunStatus(detail.status)) return detail
    return this.#waitFor(
      { runId: detail.run_id, sessionId: detail.session_id, clientId: clientIdOf(detail) },
      options
    )
  }

  async listSessions(options: SessionListOptions): Promise<SessionListResponse> {
    return sessionDecoders.listResponse(
      await this.#requestJson(sessionRoutes.list(options), { method: "GET" })
    )
  }

  async health(): Promise<HealthStatus> {
    return healthDecoders.status(await this.#requestJson(healthRoutes.status, { method: "GET" }))
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.#requestJson(sessionRoutes.archive(sessionId, { stop: false }), { method: "DELETE" })
    await this.#requestJson(sessionRoutes.permanentDelete(sessionId, { stop: false }), {
      method: "DELETE"
    })
  }

  async listModels(): Promise<ModelCatalog> {
    return modelDecoders.catalog(await this.#requestJson(modelRoutes.catalog, { method: "GET" }))
  }

  async toolCatalog(options: { readonly signal?: AbortSignal } = {}): Promise<ToolCatalogResponse> {
    return toolDecoders.catalog(
      await this.#requestJson(toolRoutes.catalog, {
        method: "GET",
        ...(options.signal === undefined ? {} : { signal: options.signal })
      })
    )
  }

  async listSpaces(): Promise<SpaceListResponse> {
    return spaceDecoders.list(await this.#requestJson(spaceRoutes.collection, { method: "GET" }))
  }

  async answerApproval(input: ToolResultInput): Promise<void> {
    await this.#requestJson(chatRoutes.toolResult, {
      method: "POST",
      body: chatRequests.toolResult(input)
    })
  }

  async answerConnection(input: ConnectionResultInput): Promise<void> {
    await this.#requestJson(chatRoutes.connectionResult, {
      method: "POST",
      body: chatRequests.connectionResult(input)
    })
  }

  async answerQuestion(questionId: string, input: ResolveRunQuestionInput): Promise<RunQuestion> {
    return runDecoders.question(
      await this.#requestJson(runRoutes.answerQuestion(questionId), {
        method: "POST",
        body: runEncoders.answerQuestion(input)
      })
    )
  }

  async #waitFor(run: RunIdentity, options: WaitForRunOptions): Promise<RunDetail> {
    const timeout = abortAfter(options.timeoutMs, (ms) => new HeadlessTimeoutError(ms), {
      unref: true
    })
    const signal =
      options.signal === undefined
        ? timeout.signal
        : AbortSignal.any([options.signal, timeout.signal])
    const reconnectDelayMs = options.reconnectDelayMs ?? 100

    try {
      while (true) {
        throwIfAborted(signal)
        let detail: RunDetail
        try {
          detail = await this.#getRun(run.runId, signal)
        } catch (cause) {
          throwIfAborted(signal)
          if (!retryableConnectionFailure(cause)) throw cause
          await sleep(reconnectDelayMs, signal)
          continue
        }
        throwIfAborted(signal)
        assertRunIdentity(detail, run)
        if (isTerminalRunStatus(detail.status)) return detail

        try {
          for await (const event of this.streamSession(run.sessionId, { signal })) {
            throwIfAborted(signal)
            if (options.onEvent !== undefined) {
              try {
                await options.onEvent(event, signal)
              } catch (cause) {
                throw new HeadlessEventHandlerError(cause)
              }
            }
            if (!shouldReconcile(event)) continue
            const reconciled = await this.#getRun(run.runId, signal)
            throwIfAborted(signal)
            assertRunIdentity(reconciled, run)
            if (isTerminalRunStatus(reconciled.status)) return reconciled
          }
        } catch (cause) {
          throwIfAborted(signal)
          if (cause instanceof ProtocolError || !retryableConnectionFailure(cause)) throw cause
        }
        await sleep(reconnectDelayMs, signal)
      }
    } catch (cause) {
      throwIfAborted(signal)
      throw cause
    } finally {
      timeout.cancel()
    }
  }

  async cancel(
    input: CancelInput,
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<CancelResponse> {
    return chatDecoders.cancel(
      await this.#requestJson(chatRoutes.cancel, {
        method: "POST",
        body: chatRequests.cancel(input),
        ...(options.signal === undefined ? {} : { signal: options.signal })
      })
    )
  }

  async #getRun(runId: string, signal?: AbortSignal): Promise<RunDetail> {
    return runDecoders.detail(
      await this.#requestJson(runRoutes.detail(runId), {
        method: "GET",
        ...(signal === undefined ? {} : { signal })
      })
    )
  }

  async #requestJson(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.#fetch(this.#url(path), {
      ...init,
      headers: this.#requestHeaders(init.body !== undefined)
    })
    if (!response.ok) throw await this.#httpError(response, init.method ?? "GET", path)
    return responseJson(response)
  }

  #requestHeaders(
    json: boolean,
    extra: Readonly<Record<string, string>> = {}
  ): Readonly<Record<string, string>> {
    return {
      ...this.#headers,
      ...(json ? { "content-type": "application/json" } : {}),
      ...extra
    }
  }

  #url(path: string): URL {
    return new URL(path, this.#baseUrl)
  }

  async #httpError(response: Response, method: string, path: string): Promise<HeadlessHttpError> {
    return new HeadlessHttpError(response.status, method, path, await responseDetail(response))
  }
}

export const createHeadlessClient = (options: HeadlessClientOptions): HeadlessClient =>
  new HeadlessClient(options)
