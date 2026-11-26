import { type Timer } from "@arden-hq/std/timer"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  MCP_AUTH,
  MCP_CONNECTION_STATUS,
  MCP_TRANSPORT,
  MCP_SIGN_IN_PROMPT,
  type McpEvent,
  type McpServer as PublicMcpServer
} from "@arden-hq/protocol/mcp"
import { Effect } from "effect"

import { VaultError } from "../credentials/vault.js"
import { errorMessage } from "@arden-hq/std/errors"
import type { McpStoreError, McpStoredServer } from "../persistence/mcp/store.js"
import { type McpToolBinding } from "./catalog.js"
import { McpConnectionError, mcpError, type McpOperation } from "./errors.js"
import { McpChannel } from "./channel.js"
import { listMcpEvents } from "./events/requests.js"
import { MCP_FAILURE_REASON, mcpFailureSentence, type McpFailureDetail } from "./failure.js"
import { STORE_REASON } from "../persistence/errors.js"
import { McpCredentialUnavailable } from "./github-connection.js"
import { mcpSignInNotSetUpDetail, type McpOwnedTransport } from "./transport.js"
import { MCP_CREDENTIALS_UNREADABLE, McpSignInNotSetUp } from "./vault.js"

const MCP_CONNECT_FAILURE = {
  credentialUnavailable: "credential_unavailable",
  toolNameCollision: "tool_name_collision",
  signInNotSetUp: "sign_in_not_set_up",
  vaultUnreadable: "vault_unreadable",
  unrunnableProgram: "unrunnable_program",
  other: "other"
} as const

export type McpConnectFailure =
  | {
      readonly kind:
        | typeof MCP_CONNECT_FAILURE.credentialUnavailable
        | typeof MCP_CONNECT_FAILURE.toolNameCollision
        | typeof MCP_CONNECT_FAILURE.signInNotSetUp
        | typeof MCP_CONNECT_FAILURE.vaultUnreadable
      readonly retryable: false
      readonly detail: string
    }
  | {
      readonly kind: typeof MCP_CONNECT_FAILURE.unrunnableProgram
      readonly retryable: false
      readonly detail: string
    }
  | { readonly kind: typeof MCP_CONNECT_FAILURE.other; readonly retryable: true }

export const shouldRetry = (
  failure: McpConnectFailure
): failure is Extract<McpConnectFailure, { readonly retryable: true }> => failure.retryable

export const toolNameCollision = (cause: unknown): McpConnectFailure | undefined =>
  cause instanceof McpToolNameCollision
    ? { kind: "tool_name_collision", retryable: false, detail: cause.message }
    : undefined

export const classifyConnectFailure = (
  cause: unknown,
  config: McpStoredServer,
  local: McpFailureDetail | undefined
): McpConnectFailure => {
  if (cause instanceof McpCredentialUnavailable)
    return { kind: "credential_unavailable", retryable: false, detail: cause.detail }
  const collision = toolNameCollision(cause)
  if (collision !== undefined) return collision
  if (
    local?.reason === MCP_FAILURE_REASON.commandNotFound ||
    local?.reason === MCP_FAILURE_REASON.notExecutable ||
    local?.reason === MCP_FAILURE_REASON.badFolder
  )
    return { kind: "unrunnable_program", retryable: false, detail: mcpFailureSentence(local) }
  if (cause instanceof McpSignInNotSetUp)
    return {
      kind: "sign_in_not_set_up",
      retryable: false,
      detail: mcpSignInNotSetUpDetail(config)
    }
  if (cause instanceof VaultError)
    return { kind: "vault_unreadable", retryable: false, detail: MCP_CREDENTIALS_UNREADABLE }
  return { kind: "other", retryable: true }
}

export type RuntimeStatus = PublicMcpServer["status"]

export interface RuntimeEntry {
  readonly config: McpStoredServer
  readonly generation: number
  readonly status: RuntimeStatus
  readonly detail: string | null
  readonly diagnostics?: string
  readonly client?: Client
  readonly transport?: McpOwnedTransport
  readonly channel?: McpChannel
  readonly tools: ReadonlyArray<McpToolBinding>
  readonly events: ReadonlyArray<McpEvent>
  readonly retryAttempt: number
  readonly retryTimer?: Timer
}

export interface McpLiveEvents {
  readonly client: Client
  readonly channel: McpChannel
  readonly events: ReadonlyArray<McpEvent>
}

export const storeFailure = (operation: McpOperation, cause: McpStoreError): McpConnectionError => {
  const reason =
    cause.reason === STORE_REASON.conflict ||
    cause.reason === STORE_REASON.not_found ||
    cause.reason === STORE_REASON.invalid
      ? cause.reason
      : "storage"
  return mcpError(operation, reason, cause.message, cause)
}

class McpToolNameCollision extends Error {
  constructor(holder: string, fullName: string) {
    super(`MCP tool name collision with server ${holder}: ${fullName}`)
  }
}

export const publicFailure = (status: RuntimeStatus): string | null => {
  switch (status) {
    case MCP_CONNECTION_STATUS.needsAuth:
      return MCP_SIGN_IN_PROMPT
    case MCP_CONNECTION_STATUS.failed:
      return "Couldn’t connect. Try again in a moment."
    case MCP_CONNECTION_STATUS.disabled:
    case MCP_CONNECTION_STATUS.starting:
    case MCP_CONNECTION_STATUS.connected:
    case MCP_CONNECTION_STATUS.reconnecting:
      return null
  }
}

export const notifyIgnoringListenerFailures = <A>(
  listeners: Iterable<(value: A) => void>,
  value: A
): void => {
  for (const listener of listeners) {
    try {
      listener(value)
    } catch {}
  }
}

export const httpStatusCode = (cause: unknown): number | undefined => {
  if (!(cause instanceof Error) || !("code" in cause)) return undefined
  return typeof cause.code === "number" ? cause.code : undefined
}

export interface ConnectOptions {
  readonly status?: "starting" | "reconnecting"
  readonly retryAttempt?: number
  readonly refreshPath?: boolean
}

export const cancelRetry = (entry: RuntimeEntry): void => entry.retryTimer?.cancel()

export const readEvents = async (
  config: McpStoredServer,
  channel: McpChannel
): Promise<ReadonlyArray<McpEvent>> => {
  if (!channel.offersEvents) return []
  return listMcpEvents(channel).catch((cause: unknown) => {
    Effect.runSync(
      Effect.logWarning("MCP server's events could not be listed").pipe(
        Effect.annotateLogs({ server: config.name, cause: errorMessage(cause) })
      )
    )
    return []
  })
}

export const boundToolNamesOf = (
  runtimes: ReadonlyMap<string, RuntimeEntry>
): Map<string, string> =>
  new Map(
    [...runtimes.values()].flatMap((entry) =>
      entry.tools.map((tool) => [tool.fullName, entry.config.name] as const)
    )
  )

export const assertUnclaimed = (
  runtimes: ReadonlyMap<string, RuntimeEntry>,
  serverName: string,
  tools: ReadonlyArray<McpToolBinding>
): void => {
  const bound = boundToolNamesOf(runtimes)
  for (const tool of tools) {
    const holder = bound.get(tool.fullName)
    if (holder !== undefined && holder !== serverName) {
      throw new McpToolNameCollision(holder, tool.fullName)
    }
  }
}

export const usesOAuth = (config: McpStoredServer): boolean =>
  config.transport.type === MCP_TRANSPORT.http && config.transport.auth === MCP_AUTH.oauth

export const isConnected = (
  entry: RuntimeEntry | undefined
): entry is RuntimeEntry & { readonly status: typeof MCP_CONNECTION_STATUS.connected } =>
  entry?.status === MCP_CONNECTION_STATUS.connected

export const isReconnecting = (entry: RuntimeEntry): boolean =>
  entry.status === MCP_CONNECTION_STATUS.reconnecting
