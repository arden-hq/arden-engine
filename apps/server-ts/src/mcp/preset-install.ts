import type { McpPresetId, McpServer as PublicMcpServer } from "@arden-hq/protocol/mcp"
import { Effect } from "effect"

import { McpStore, type McpStoredServer } from "../persistence/mcp/store.js"
import { McpConnectionError, mcpError } from "./errors.js"
import { MCP_PRESETS, mcpPresetTransportAuth } from "./presets.js"
import { storeFailure } from "./runtime-state.js"
import { KeyedSerialQueue } from "./serial.js"
import type { McpRuntime } from "./runtime-types.js"

const runServerOperations = <A>(
  queue: KeyedSerialQueue,
  names: ReadonlyArray<string>,
  operation: () => Promise<A>
): Promise<A> => {
  const keys = [...new Set(names)].sort()
  const run = (index: number): Promise<A> => {
    const key = keys[index]
    return key === undefined ? operation() : queue.run(key, () => run(index + 1))
  }
  return run(0)
}
export type InstallPreset = (
  presetId: McpPresetId
) => Effect.Effect<Array<PublicMcpServer>, McpConnectionError>

export const makeInstallPreset =
  ({
    store,
    runtime,
    operations
  }: {
    readonly store: McpStore["Service"]
    readonly runtime: McpRuntime
    readonly operations: KeyedSerialQueue
  }): InstallPreset =>
  (presetId: McpPresetId) =>
    Effect.tryPromise({
      try: () => {
        const definitions = MCP_PRESETS[presetId].servers.map(
          (server) =>
            ({
              name: server.name,
              presetId,
              enabled: true,
              transport: {
                type: "http" as const,
                url: server.url,
                auth: mcpPresetTransportAuth(presetId),
                headerKeys: []
              }
            }) satisfies McpStoredServer
        )
        return runServerOperations(
          operations,
          definitions.map((server) => server.name),
          async () => {
            const installed = await Effect.runPromise(
              store
                .installPreset(presetId, definitions)
                .pipe(Effect.mapError((cause) => storeFailure("install_preset", cause)))
            )
            for (const config of installed) {
              if (!runtime.has(config.name)) runtime.start(config)
            }
            return installed.map((config) =>
              runtime.snapshotOne(runtime.requireRuntime(config.name, "install_preset"))
            )
          }
        )
      },
      catch: (cause) =>
        cause instanceof McpConnectionError
          ? cause
          : mcpError("install_preset", "storage", "MCP preset could not be installed", cause)
    })
