export const MCP_CONNECTION_STATUS = {
  disabled: "disabled",
  starting: "starting",
  connected: "connected",
  reconnecting: "reconnecting",
  needsAuth: "needs_auth",
  failed: "failed"
} as const

export type McpConnectionStatus = (typeof MCP_CONNECTION_STATUS)[keyof typeof MCP_CONNECTION_STATUS]

interface ServerFacts {
  readonly enabled: boolean
  readonly status: McpConnectionStatus
}

export const MCP_SIGN_IN_PROMPT = "Sign in to continue."
export const MCP_NEEDS_SIGN_IN_WORD = "Needs sign-in"
export const MCP_SIGN_IN_ACTION = "Sign in"

export const mcpServerNeedsSignIn = (server: ServerFacts): boolean =>
  server.enabled && server.status === MCP_CONNECTION_STATUS.needsAuth

export const mcpServersConnected = (servers: ReadonlyArray<ServerFacts>): boolean => {
  const enabled = servers.filter((server) => server.enabled)
  return (
    !enabled.some((server) => server.status === MCP_CONNECTION_STATUS.needsAuth) &&
    enabled.some((server) => server.status === MCP_CONNECTION_STATUS.connected)
  )
}

export const MCP_SERVERS_STATE = {
  absent: "absent",
  off: "off",
  needsAuth: "needs_auth",
  failed: "failed",
  starting: "starting",
  ready: "ready"
} as const

export type McpServersState = (typeof MCP_SERVERS_STATE)[keyof typeof MCP_SERVERS_STATE]

export const mcpServersState = (servers: ReadonlyArray<ServerFacts>): McpServersState => {
  if (servers.length === 0) return MCP_SERVERS_STATE.absent
  const enabled = servers.filter((server) => server.enabled)
  if (enabled.length === 0) return MCP_SERVERS_STATE.off
  if (enabled.some((server) => server.status === MCP_CONNECTION_STATUS.needsAuth))
    return MCP_SERVERS_STATE.needsAuth
  if (enabled.some((server) => server.status === MCP_CONNECTION_STATUS.failed))
    return MCP_SERVERS_STATE.failed
  if (enabled.every((server) => server.status === MCP_CONNECTION_STATUS.connected))
    return MCP_SERVERS_STATE.ready
  return MCP_SERVERS_STATE.starting
}
