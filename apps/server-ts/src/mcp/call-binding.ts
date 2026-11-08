import type { Client } from "@modelcontextprotocol/sdk/client/index.js"

import { MCP_SIGN_IN_PROMPT } from "@arden-hq/protocol/mcp"
import type { McpToolBinding } from "./catalog.js"
import { mcpError } from "./errors.js"
import type { RuntimeEntry } from "./runtime.js"

export const resolveMcpCall = (
  current: Pick<RuntimeEntry, "status" | "client" | "tools"> | undefined,
  input: { readonly serverName: string; readonly remoteName: string; readonly contract: string }
): { readonly client: Client; readonly binding: McpToolBinding } => {
  if (current?.status === "needs_auth") {
    throw mcpError("call", "auth_required", MCP_SIGN_IN_PROMPT)
  }
  if (current?.status !== "connected" || current.client === undefined) {
    throw mcpError("call", "unavailable", `${input.serverName} is not connected.`)
  }
  const binding = current.tools.find((tool) => tool.remoteName === input.remoteName)
  if (binding === undefined) {
    throw mcpError(
      "call",
      "unavailable",
      `${input.serverName} no longer has the tool ${input.remoteName}.`
    )
  }
  if (binding.contract !== input.contract) {
    throw mcpError(
      "call",
      "unavailable",
      `The ${input.serverName} tool ${input.remoteName} changed. Use it again after the tool list updates.`
    )
  }
  return { client: current.client, binding }
}

export const sameMcpTools = (
  left: ReadonlyArray<McpToolBinding>,
  right: ReadonlyArray<McpToolBinding>
): boolean => {
  if (left.length !== right.length) return false
  const known = new Map(left.map((tool) => [tool.remoteName, tool]))
  return right.every((tool) => {
    const before = known.get(tool.remoteName)
    return (
      before !== undefined &&
      before.contract === tool.contract &&
      before.outputContract === tool.outputContract &&
      before.executionIdentity === tool.executionIdentity &&
      before.title === tool.title &&
      before.description === tool.description
    )
  })
}
