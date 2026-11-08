import { Effect } from "effect"
import type { ToolProvider } from "../tools/provider.js"
import type { McpToolBinding } from "./catalog.js"
import { McpConnections } from "./service.js"
import { makeMcpTool } from "./tool.js"
import { sha256Hex } from "@arden-hq/std/hash"

const bindingKey = (binding: McpToolBinding): string =>
  sha256Hex(
    JSON.stringify([
      binding.fullName,
      binding.title,
      binding.description,
      binding.inputSchema,
      binding.defaultApproval,
      binding.readOnly,
      binding.destructive,
      binding.idempotent,
      binding.openWorld
    ])
  )

export const mcpToolProvider = Effect.gen(function* () {
  const connections = yield* McpConnections
  const tools = () => connections.bindings().map((binding) => makeMcpTool({ binding, connections }))
  const runTools = () =>
    connections.runBindings().map((binding) => makeMcpTool({ binding, connections }))
  const keys = new WeakMap<McpToolBinding, string>()
  const keyOf = (binding: McpToolBinding): string => {
    const known = keys.get(binding)
    if (known !== undefined) return known
    const key = bindingKey(binding)
    keys.set(binding, key)
    return key
  }
  const provider: ToolProvider = {
    catalog: tools,
    forRun: runTools,
    revision: () => connections.runBindings().map(keyOf).sort().join("\n")
  }
  return provider
})
