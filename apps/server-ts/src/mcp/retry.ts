import { backoffDelayMs } from "@arden-hq/std/retry"

import type { McpFailureReason } from "./failure.js"

const MAX_RECONNECT_ATTEMPTS = 3

export const mcpConnectBudgetMs = ({
  transport,
  firstStart
}: {
  readonly transport: "stdio" | "http"
  readonly firstStart: boolean
}): number => {
  if (transport === "http") return 15_000
  return firstStart ? 60_000 : 30_000
}

export const nextConnectRetryMs = ({
  phase,
  attempt,
  reason,
  needsAuth
}: {
  readonly phase: "starting" | "reconnecting"
  readonly attempt: number
  readonly reason: McpFailureReason | undefined
  readonly needsAuth: boolean
}): number | undefined => {
  if (needsAuth || (reason !== undefined && !transient(reason))) return undefined
  if (phase === "starting") return attempt === 0 && reason !== undefined ? 1_000 : undefined
  return attempt < MAX_RECONNECT_ATTEMPTS ? reconnectDelayMs(attempt + 1) : undefined
}

export const reconnectDelayMs = (attempt: number): number =>
  backoffDelayMs({ initialMs: 1_000, maxMs: Infinity }, attempt)

export const canReconnect = (attempt: number): boolean => attempt <= MAX_RECONNECT_ATTEMPTS

const transient = (reason: McpFailureReason): boolean => {
  switch (reason) {
    case "exited_early":
    case "timeout":
    case "crashed":
      return true
    case "command_not_found":
    case "not_executable":
    case "bad_folder":
      return false
  }
}
