import { backoffDelayMs } from "@arden-hq/std/retry"

import { MCP_CONNECTION_STATUS, MCP_TRANSPORT, type McpTransportKind } from "@arden-hq/protocol/mcp"

import type { McpFailureReason } from "./failure.js"

const MCP_CONNECT_PHASE = {
  starting: MCP_CONNECTION_STATUS.starting,
  reconnecting: MCP_CONNECTION_STATUS.reconnecting
} as const

export type McpConnectPhase = (typeof MCP_CONNECT_PHASE)[keyof typeof MCP_CONNECT_PHASE]

const MAX_RECONNECT_ATTEMPTS = 3

export const mcpConnectBudgetMs = ({
  transport,
  firstStart
}: {
  readonly transport: McpTransportKind
  readonly firstStart: boolean
}): number => {
  if (transport === MCP_TRANSPORT.http) return 15_000
  return firstStart ? 60_000 : 30_000
}

export const nextConnectRetryMs = ({
  phase,
  attempt,
  reason,
  needsAuth
}: {
  readonly phase: McpConnectPhase
  readonly attempt: number
  readonly reason: McpFailureReason | undefined
  readonly needsAuth: boolean
}): number | undefined => {
  if (needsAuth || (reason !== undefined && !transient(reason))) return undefined
  if (phase === MCP_CONNECT_PHASE.starting)
    return attempt === 0 && reason !== undefined ? 1_000 : undefined
  return attempt < MAX_RECONNECT_ATTEMPTS ? reconnectDelayMs(attempt + 1) : undefined
}

export const reconnectDelayMs = (attempt: number): number =>
  backoffDelayMs({ initialMs: 1_000, maxMs: Infinity }, attempt)

export const canReconnect = (attempt: number): boolean => attempt <= MAX_RECONNECT_ATTEMPTS

const TRANSIENT: Record<McpFailureReason, boolean> = {
  exited_early: true,
  timeout: true,
  crashed: true,
  command_not_found: false,
  not_executable: false,
  bad_folder: false
}

const transient = (reason: McpFailureReason): boolean => TRANSIENT[reason]
