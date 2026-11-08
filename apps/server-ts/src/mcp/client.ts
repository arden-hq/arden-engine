import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"

import type { McpToolBinding } from "./catalog.js"
import { mcpError } from "./errors.js"
import type { McpChannel } from "./channel.js"
import type { McpOwnedTransport } from "./transport.js"

const CALL_TIMEOUT_MS = 60_000
const CALL_MAX_TOTAL_MS = 30 * 60_000
const CLOSE_TIMEOUT_MS = 2_000

export interface McpToolCall {
  readonly serverName: string
  readonly remoteName: string
  readonly contract: string
  readonly arguments: Readonly<Record<string, unknown>>
  readonly signal: AbortSignal
  readonly execution?: {
    readonly run_id: string
    readonly tool_call_id: string
    readonly chat_id: string
  }
  readonly onSent?: () => void
  readonly onProgress?: (progress: {
    readonly progress: number
    readonly total?: number
    readonly message?: string
  }) => void
}

export interface ClosableClient {
  readonly client?: Client
  readonly transport?: McpOwnedTransport
}

/** SDK 1.29's transport declaration is not exact-optional compatible. */
const clientTransport = (transport: McpOwnedTransport | McpChannel): Transport =>
  transport as unknown as Transport

export class McpTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    options?: ErrorOptions
  ) {
    super(
      options?.cause === undefined
        ? "MCP operation timed out"
        : "MCP operation timed out during cleanup",
      options
    )
    this.name = "McpTimeoutError"
  }
}

const promiseWithTimeout = async <A>(
  promise: Promise<A>,
  timeoutMs: number,
  onTimeout: () => void | Promise<void>
): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void Promise.resolve(onTimeout()).then(
        () => reject(new McpTimeoutError(timeoutMs)),
        (cause: unknown) => reject(new McpTimeoutError(timeoutMs, { cause }))
      )
    }, timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export const makeMcpClient = () =>
  new Client(
    { name: "arden", version: "0.1.0" },
    { capabilities: {}, jsonSchemaValidator: new AjvJsonSchemaValidator() }
  )

export const connectMcpClient = (
  client: Client,
  transport: McpOwnedTransport | McpChannel,
  timeoutMs: number
): Promise<void> =>
  promiseWithTimeout(client.connect(clientTransport(transport)), timeoutMs, () => client.close())

export const closeMcpClient = async (entry: ClosableClient | undefined): Promise<void> => {
  const client = entry?.client
  const transport = entry?.transport
  if (client === undefined) return
  client.onclose = () => undefined
  await promiseWithTimeout(client.close(), CLOSE_TIMEOUT_MS, () => transport?.close()).catch(
    () => undefined
  )
}

export const callMcpTool = async ({
  client,
  binding,
  input
}: {
  readonly client: Client
  readonly binding: McpToolBinding
  readonly input: McpToolCall
}): Promise<CallToolResult> => {
  // A progress handler is always set: without one the SDK sends no progress
  // token, so the server can't report progress and reset the timeout.
  const options: RequestOptions = {
    signal: input.signal,
    timeout: CALL_TIMEOUT_MS,
    maxTotalTimeout: CALL_MAX_TOTAL_MS,
    resetTimeoutOnProgress: true,
    onprogress: (progress) =>
      input.onProgress?.({
        progress: progress.progress,
        ...(progress.total === undefined ? {} : { total: progress.total }),
        ...(progress.message === undefined ? {} : { message: progress.message })
      })
  }
  input.onSent?.()
  const result = await client.callTool(
    {
      name: input.remoteName,
      arguments: input.arguments,
      ...(binding.executionIdentity !== true || input.execution === undefined
        ? {}
        : { _meta: { "arden/execution": input.execution } })
    },
    undefined,
    options
  )
  const parsed = CallToolResultSchema.safeParse(result)
  if (!parsed.success) {
    throw mcpError("call", "unavailable", "MCP task execution is unsupported")
  }
  if (binding.validateOutput !== undefined && parsed.data.isError !== true) {
    if (parsed.data.structuredContent === undefined) {
      throw mcpError("call", "unavailable", "MCP tool omitted its declared structured result")
    }
    const validated = binding.validateOutput(parsed.data.structuredContent)
    if (!validated.valid) {
      throw mcpError("call", "unavailable", "MCP tool returned an invalid structured result")
    }
  }
  return parsed.data
}
