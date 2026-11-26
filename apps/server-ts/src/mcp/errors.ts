import { Schema } from "effect"

export const MCP_OPERATION = {
  list: "list",
  create: "create",
  installPreset: "install_preset",
  update: "update",
  setEnabled: "set_enabled",
  reconnect: "reconnect",
  remove: "remove",
  oauth: "oauth",
  call: "call",
  github: "github"
} as const

export type McpOperation = (typeof MCP_OPERATION)[keyof typeof MCP_OPERATION]

export type McpSaveOperation = typeof MCP_OPERATION.create | typeof MCP_OPERATION.update

const McpOperation = Schema.Literals(Object.values(MCP_OPERATION))

export const MCP_ERROR_REASON = {
  notFound: "not_found",
  conflict: "conflict",
  invalid: "invalid",
  unavailable: "unavailable",
  storage: "storage",
  authRequired: "auth_required",
  notSetUp: "not_set_up",
  rejected: "rejected"
} as const

export type McpErrorReason = (typeof MCP_ERROR_REASON)[keyof typeof MCP_ERROR_REASON]

export class McpConnectionError extends Schema.TaggedError<McpConnectionError>()(
  "McpConnectionError",
  {
    operation: McpOperation,
    reason: Schema.Literals(Object.values(MCP_ERROR_REASON)),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export const mcpError = (
  operation: McpOperation,
  reason: McpErrorReason,
  message: string,
  cause?: unknown
): McpConnectionError =>
  new McpConnectionError({
    operation,
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })
