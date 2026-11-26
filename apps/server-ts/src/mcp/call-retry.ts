import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"
import { MCP_TRANSPORT, type McpTransportKind } from "@arden-hq/protocol/mcp"

export const retriesMcpCall = ({
  cause,
  transport,
  readOnly
}: {
  readonly cause: unknown
  readonly transport: McpTransportKind
  readonly readOnly: boolean
}): boolean => {
  if (transport !== MCP_TRANSPORT.http) return false
  if (cause instanceof StreamableHTTPError) return cause.code === 404
  if (cause instanceof McpError) return readOnly && cause.code === ErrorCode.ConnectionClosed
  return false
}
