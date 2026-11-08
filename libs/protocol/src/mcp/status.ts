export const MCP_CONNECTION_STATUSES = [
  "disabled",
  "starting",
  "connected",
  "reconnecting",
  "needs_auth",
  "failed"
] as const

export type McpConnectionStatus = (typeof MCP_CONNECTION_STATUSES)[number]

interface ServerFacts {
  readonly enabled: boolean
  readonly status: McpConnectionStatus
}

/** The owner's sentence when a call needs a sign-in. */
export const MCP_SIGN_IN_PROMPT = "Sign in to continue."
/** The word a connection's status column shows while it waits on a sign-in. */
export const MCP_NEEDS_SIGN_IN_WORD = "Needs sign-in"
/** The button that starts that sign-in. */
export const MCP_SIGN_IN_ACTION = "Sign in"

/** A server that is switched on and waits on a sign-in. A switched-off server
 *  keeps its last status, so `status` alone is not the question. */
export const mcpServerNeedsSignIn = (server: ServerFacts): boolean =>
  server.enabled && server.status === "needs_auth"

/** A group of servers (a preset's) counts as connected when some switched-on
 *  server is connected and none waits on a sign-in; a sibling still starting,
 *  reconnecting or failed does not undo it. */
export const mcpServersConnected = (servers: ReadonlyArray<ServerFacts>): boolean => {
  const enabled = servers.filter((server) => server.enabled)
  return (
    !enabled.some((server) => server.status === "needs_auth") &&
    enabled.some((server) => server.status === "connected")
  )
}

/** `absent`: no server; `off`: none switched on; `needs_auth`, `failed`: a switched-on
 *  server says so (signing in outranks failing); `ready`: every switched-on
 *  server is connected; `starting`: the rest, still arriving. */
export type McpServersState = "absent" | "off" | "needs_auth" | "failed" | "starting" | "ready"

/** What a set of servers (one preset's, or one custom server) says as a whole.
 *  Only servers that are switched on count. */
export const mcpServersState = (servers: ReadonlyArray<ServerFacts>): McpServersState => {
  if (servers.length === 0) return "absent"
  const enabled = servers.filter((server) => server.enabled)
  if (enabled.length === 0) return "off"
  if (enabled.some((server) => server.status === "needs_auth")) return "needs_auth"
  if (enabled.some((server) => server.status === "failed")) return "failed"
  if (enabled.every((server) => server.status === "connected")) return "ready"
  return "starting"
}
