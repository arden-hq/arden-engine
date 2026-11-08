import { formatBytes } from "@arden-hq/std/count"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type {
  FetchLike,
  Transport,
  TransportSendOptions
} from "@modelcontextprotocol/sdk/shared/transport.js"
import { deserializeMessage, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import { spawn, type ChildProcess } from "node:child_process"

import type { McpStoredServer } from "../persistence/mcp/store.js"
import { resolveLoginShellPath } from "../runtime/login-shell-path.js"
import { prepareMcpStdioLaunch, type McpStdioLaunch } from "./launch.js"
import { redactSecrets, StderrTail } from "./stderr-tail.js"
import { McpOAuthProvider } from "./oauth.js"
import {
  MCP_PRESETS,
  resolveMcpPresetServer,
  usesPresetToken,
  type McpStaticOAuthMetadata
} from "./presets.js"
import { KeyedSerialQueue } from "./serial.js"
import {
  resolveMcpOAuthClient,
  type McpOAuthVault,
  type McpOAuthVaultTarget,
  type McpTransportSecretTarget
} from "./vault.js"
import { errorMessage, toError } from "@arden-hq/std/errors"
import { canDetach, signalProcessGroup } from "@arden-hq/std/process"

const MAX_REDIRECTS = 10
const MAX_HTTP_RESPONSE_BYTES = 16 * 1_024 * 1_024
const MAX_STDIO_MESSAGE_BYTES = 16 * 1_024 * 1_024
const PROCESS_EXIT_GRACE_MS = 250

const redirectStatuses = new Set([301, 302, 303, 307, 308])

class McpHttpResponseTooLargeError extends Error {
  readonly code = "MCP_HTTP_RESPONSE_TOO_LARGE"

  constructor(
    readonly reason: "declared_length" | "streamed_bytes",
    readonly observedBytes: number
  ) {
    super(
      `MCP HTTP response exceeded Arden's ${formatBytes(MAX_HTTP_RESPONSE_BYTES)} transport limit (${observedBytes} bytes ${
        reason === "declared_length" ? "declared" : "received"
      }). Ask the MCP server to return a smaller result or a resource link.`
    )
    this.name = "McpHttpResponseTooLargeError"
  }
}

const redirectedRequest = (request: Request, response: Response): Request => {
  const location = response.headers.get("location")
  if (location === null) return request
  const nextUrl = new URL(location, request.url)
  const originalUrl = new URL(request.url)
  if (nextUrl.origin !== originalUrl.origin) {
    throw new Error("MCP HTTP redirect to a different origin is not allowed")
  }
  const becomesGet =
    response.status === 303 ||
    ((response.status === 301 || response.status === 302) && request.method === "POST")
  if (!becomesGet) return new Request(nextUrl, request)
  const headers = new Headers(request.headers)
  for (const name of ["content-encoding", "content-length", "content-type", "transfer-encoding"]) {
    headers.delete(name)
  }
  return new Request(nextUrl, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers,
    signal: request.signal
  })
}

const boundedResponse = async (response: Response): Promise<Response> => {
  const declaredBytes = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_HTTP_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new McpHttpResponseTooLargeError("declared_length", declaredBytes)
  }
  if (response.body === null) return response
  if (response.headers.get("content-type")?.includes("text/event-stream") === true) {
    return new Response(response.body.pipeThrough(boundedSseEvents()), response)
  }

  let receivedBytes = 0
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        receivedBytes += chunk.byteLength
        if (receivedBytes > MAX_HTTP_RESPONSE_BYTES) {
          controller.error(new McpHttpResponseTooLargeError("streamed_bytes", receivedBytes))
          return
        }
        controller.enqueue(chunk)
      }
    })
  )
  return new Response(body, response)
}

const LINE_FEED = 0x0a
const CARRIAGE_RETURN = 0x0d

const boundedSseEvents = (): TransformStream<Uint8Array, Uint8Array> => {
  let eventBytes = 0
  let lineFeeds = 0
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      for (const byte of chunk) {
        if (byte === CARRIAGE_RETURN) continue
        lineFeeds = byte === LINE_FEED ? lineFeeds + 1 : 0
        eventBytes = lineFeeds >= 2 ? 0 : eventBytes + 1
      }
      if (eventBytes > MAX_HTTP_RESPONSE_BYTES) {
        controller.error(new McpHttpResponseTooLargeError("streamed_bytes", eventBytes))
        return
      }
      controller.enqueue(chunk)
    }
  })
}

export const createSameOriginFetch = (): FetchLike => async (input, init) => {
  let request = new Request(input, { ...init, redirect: "manual" })
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await globalThis.fetch(request.clone(), { redirect: "manual" })
    if (!redirectStatuses.has(response.status) || response.headers.get("location") === null) {
      return boundedResponse(response)
    }
    if (redirects === MAX_REDIRECTS) {
      await response.body?.cancel()
      throw new Error("MCP HTTP request exceeded the redirect limit")
    }
    const next = redirectedRequest(request, response)
    await response.body?.cancel()
    request = next
  }
  throw new Error("MCP HTTP request exceeded the redirect limit")
}

const withRequestHeaders =
  (fetch: FetchLike, headers: () => Promise<Readonly<Record<string, string>>>): FetchLike =>
  async (input, init) => {
    const merged = new Headers(init?.headers)
    for (const [name, value] of Object.entries(await headers())) merged.set(name, value)
    return fetch(input, { ...init, headers: merged })
  }

const waitForClose = (child: ChildProcess, timeoutMs: number): Promise<void> =>
  new Promise((resolve) => {
    const onClose = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      child.off("close", onClose)
      resolve()
    }, timeoutMs)
    child.once("close", onClose)
  })

const waitForExit = (child: ChildProcess, timeoutMs: number): Promise<void> =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : waitForClose(child, timeoutMs)

export type McpOwnedTransport = McpStdioTransport | StreamableHTTPClientTransport

export interface McpTransportOptions {
  readonly vault?: McpOAuthVault
  readonly credentials: KeyedSerialQueue
  readonly onAuthorization: (url: URL) => void
  readonly beforeIdentityReplacement: () => Promise<void>
  readonly transportSecrets: Readonly<Record<string, string>>
  readonly refreshPath: boolean
  readonly presetHeaders: () => Promise<Readonly<Record<string, string>>>
  readonly wrapFetch: (fetch: FetchLike) => FetchLike
}

export const mcpOAuthVaultTarget = (config: McpStoredServer): McpOAuthVaultTarget => {
  if (config.transport.type !== "http") {
    throw new Error("Only HTTP MCP servers have OAuth credential targets")
  }
  if (config.presetId === null) {
    return {
      credentialKey: `server:${config.name}`,
      binding: `server:${config.name}:${config.transport.url}`
    }
  }
  const auth = MCP_PRESETS[config.presetId].auth
  if (resolveMcpPresetServer(config) === undefined || auth.type !== "oauth") {
    throw new Error("Stored MCP preset identity does not match its trusted definition")
  }
  return {
    credentialKey: auth.credentialKey,
    binding: `preset:${config.presetId}`
  }
}

export const mcpTransportSecretTarget = (config: McpStoredServer): McpTransportSecretTarget => ({
  secretKey: `transport:${config.name}`,
  binding: `server:${config.name}`
})

export const mcpStaticOAuth = (config: McpStoredServer): McpStaticOAuthMetadata | undefined => {
  if (config.presetId === null || resolveMcpPresetServer(config) === undefined) return undefined
  const auth = MCP_PRESETS[config.presetId].auth
  return auth.type === "oauth" && auth.clientType === "confidential" ? auth : undefined
}

export const mcpServiceTitle = (config: McpStoredServer): string =>
  config.presetId === null ? config.name : MCP_PRESETS[config.presetId].title

export const mcpSignInNotSetUpDetail = (config: McpStoredServer): string =>
  `${mcpServiceTitle(config)} needs app credentials. Open Manage to set up your own app.`

export const assertMcpSignInSetUp = async (
  config: McpStoredServer,
  vault: McpOAuthVault | undefined
): Promise<void> => {
  const staticOAuth = mcpStaticOAuth(config)
  if (staticOAuth !== undefined) {
    await resolveMcpOAuthClient(vault, {
      clientIdReference: staticOAuth.clientIdReference,
      clientSecretReference: staticOAuth.clientSecretReference
    })
  }
}

export const makeMcpTransport = async (
  config: McpStoredServer,
  options: McpTransportOptions
): Promise<McpOwnedTransport> => {
  const value = config.transport
  if (value.type === "stdio") {
    return new McpStdioTransport(
      await prepareMcpStdioLaunch({
        transport: value,
        secrets: options.transportSecrets,
        loginPath: await resolveLoginShellPath({ refresh: options.refreshPath })
      })
    )
  }
  if (usesPresetToken(config)) {
    return new StreamableHTTPClientTransport(new URL(value.url), {
      fetch: options.wrapFetch(withRequestHeaders(createSameOriginFetch(), options.presetHeaders))
    })
  }
  const staticOAuth = mcpStaticOAuth(config)
  const oauth =
    value.auth === "oauth"
      ? new McpOAuthProvider({
          target: mcpOAuthVaultTarget(config),
          ...(options.vault === undefined ? {} : { vault: options.vault }),
          ...(staticOAuth === undefined ? {} : { staticOAuth }),
          credentials: options.credentials,
          onAuthorization: options.onAuthorization,
          beforeIdentityReplacement: options.beforeIdentityReplacement
        })
      : undefined
  return new StreamableHTTPClientTransport(new URL(value.url), {
    fetch: options.wrapFetch(createSameOriginFetch()),
    ...(oauth === undefined ? {} : { authProvider: oauth }),
    ...(value.auth !== "headers" ? {} : { requestInit: { headers: options.transportSecrets } })
  })
}

export class McpStdioTransport implements Transport {
  onclose?: NonNullable<Transport["onclose"]>
  onerror?: NonNullable<Transport["onerror"]>
  onmessage?: NonNullable<Transport["onmessage"]>

  private child: ChildProcess | undefined
  private readBuffer = Buffer.alloc(0)
  private closePromise: Promise<void> | undefined
  private closeNotified = false
  private readonly stderr = new StderrTail()
  private ended = false

  constructor(private readonly launch: McpStdioLaunch) {}

  get executable(): string {
    return this.launch.executable
  }

  get exited(): boolean {
    return this.ended
  }

  stderrTail(): string | undefined {
    return this.stderr.read(this.launch.secretValues)
  }

  diagnostics(cause: unknown): string | undefined {
    const message = errorMessage(cause)
    const tail = this.stderrTail()
    return redactSecrets(
      tail === undefined ? message : `${message}\n\nstderr:\n${tail}`,
      this.launch.secretValues
    )
  }

  async start(): Promise<void> {
    if (this.child !== undefined) throw new Error("MCP stdio transport is already started")
    const child = spawn(this.launch.executable, [...this.launch.args], {
      env: this.launch.environment,
      cwd: this.launch.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      detached: canDetach
    })
    this.child = child
    const stdout = child.stdout
    if (stdout === null || child.stdin === null) {
      await this.close()
      throw new Error("MCP stdio transport did not receive pipes")
    }
    stdout.on("data", (chunk: Buffer) => this.receive(chunk))
    // Always drained, so a chatty server never blocks on a full pipe.
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => this.stderr.push(chunk))
    child.stderr?.on("error", () => undefined)
    stdout.on("error", (cause) => this.onerror?.(cause))
    child.stdin.on("error", (cause) => this.onerror?.(cause))
    child.on("close", () => {
      this.ended = true
      if (this.child === child) this.child = undefined
      void this.beginTermination(child)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (cause: Error) => {
          child.off("spawn", onSpawn)
          reject(cause)
        }
        const onSpawn = () => {
          child.off("error", onError)
          child.on("error", (cause) => this.onerror?.(cause))
          resolve()
        }
        child.once("error", onError)
        child.once("spawn", onSpawn)
      })
    } catch (cause) {
      this.ended = true
      await this.close()
      throw cause
    }
  }

  async close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    const child = this.child
    this.child = undefined
    if (child === undefined) return
    await this.beginTermination(child)
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const child = this.child
    const stdin = child?.stdin
    if (child === undefined || stdin === undefined || stdin === null)
      throw new Error("MCP stdio transport is not connected")
    const failure = await new Promise<Error | undefined>((resolve) => {
      stdin.write(serializeMessage(message), (cause) => resolve(cause ?? undefined))
    })
    if (failure === undefined) return
    // A write fails (EPIPE) when the process has closed its stdin, usually as
    // it exits, and can land before its close event. Waiting for that close
    // lets the caller read the exit and the whole stderr tail, not a bare EPIPE.
    if (!this.ended) await waitForClose(child, PROCESS_EXIT_GRACE_MS)
    throw failure
  }

  private receive(chunk: Buffer): void {
    this.readBuffer = Buffer.concat([this.readBuffer, chunk])
    if (this.readBuffer.length > MAX_STDIO_MESSAGE_BYTES) {
      this.onerror?.(new Error("MCP stdio message exceeded the size limit"))
      void this.close()
      return
    }
    let newline = this.readBuffer.indexOf(10)
    while (newline >= 0) {
      const line = this.readBuffer.subarray(0, newline).toString("utf8").replace(/\r$/, "")
      this.readBuffer = this.readBuffer.subarray(newline + 1)
      if (line.length > 0) {
        try {
          this.onmessage?.(deserializeMessage(line))
        } catch (cause) {
          this.onerror?.(toError(cause))
        }
      }
      newline = this.readBuffer.indexOf(10)
    }
  }

  private async terminate(child: ChildProcess): Promise<void> {
    try {
      child.stdin?.end()
    } catch {
      // Continue to process-group termination.
    }
    await waitForExit(child, PROCESS_EXIT_GRACE_MS)
    signalProcessGroup(child.pid, "SIGTERM", (signal) => child.kill(signal))
    await waitForExit(child, PROCESS_EXIT_GRACE_MS)
    signalProcessGroup(child.pid, "SIGKILL", (signal) => child.kill(signal))
    await waitForExit(child, PROCESS_EXIT_GRACE_MS)
    this.readBuffer = Buffer.alloc(0)
  }

  private beginTermination(child: ChildProcess): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closePromise = this.terminate(child).finally(() => this.notifyClose())
    return this.closePromise
  }

  private notifyClose(): void {
    if (this.closeNotified) return
    this.closeNotified = true
    this.onclose?.()
  }
}
