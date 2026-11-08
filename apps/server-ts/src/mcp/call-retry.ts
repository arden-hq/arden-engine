import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"

/**
 * Whether a failed tool call is worth one more try on a fresh connection.
 * A remote server forgets a session when it restarts or the session times
 * out, and then answers the next POST with 404: it never ran the call, so
 * any tool may be sent again. A connection that closed mid-call may have run
 * it, so only a read-only tool is sent again. A sign-in failure (401), a
 * timeout, an abort and the server's own error result are never retried.
 */
export const retriesMcpCall = ({
  cause,
  transport,
  readOnly
}: {
  readonly cause: unknown
  readonly transport: "stdio" | "http"
  readonly readOnly: boolean
}): boolean => {
  if (transport !== "http") return false
  if (cause instanceof StreamableHTTPError) return cause.code === 404
  if (cause instanceof McpError) return readOnly && cause.code === ErrorCode.ConnectionClosed
  return false
}
