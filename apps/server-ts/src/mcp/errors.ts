import { Schema } from "effect"

const McpOperation = Schema.Literals([
  "list",
  "create",
  "install_preset",
  "update",
  "set_enabled",
  "reconnect",
  "remove",
  "oauth",
  "call",
  "github"
] as const)
export type McpOperation = typeof McpOperation.Type

export class McpConnectionError extends Schema.TaggedError<McpConnectionError>()(
  "McpConnectionError",
  {
    operation: McpOperation,
    reason: Schema.Literals([
      "not_found",
      "conflict",
      "invalid",
      "unavailable",
      "storage",
      "auth_required",
      "not_set_up",
      "rejected"
    ] as const),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export const mcpError = (
  operation: McpOperation,
  reason: McpConnectionError["reason"],
  message: string,
  cause?: unknown
) =>
  new McpConnectionError({
    operation,
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })
