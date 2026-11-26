import type { PauseRequested } from "@arden-hq/loop"
import { MCP_CONNECTION_STATUS } from "@arden-hq/protocol/mcp"
import { Effect } from "effect"

import {
  CONNECTION_CHECK_FAILURE,
  CONNECTION_PROVIDER,
  ConnectionCheckError,
  requestConnection,
  type ConnectionCheck
} from "../connections/recovery.js"
import { McpConnections } from "./service.js"

export const mcpConnectionPause = (serverName: string, detail: string): PauseRequested =>
  requestConnection({
    provider: CONNECTION_PROVIDER.mcp,
    service: serverName,
    label: serverName,
    reason: "auth_required",
    detail,
    capability: `Use ${serverName}`,
    action: "oauth",
    settingsTab: "integrations",
    requiredScopes: []
  })

export const mcpConnectionCheck: Effect.Effect<ConnectionCheck, never, McpConnections> = Effect.gen(
  function* () {
    const connections = yield* McpConnections
    return (decision) =>
      connections
        .snapshot()
        .pipe(
          Effect.flatMap((servers) =>
            servers.some(
              (server) =>
                server.name === decision.service &&
                server.status === MCP_CONNECTION_STATUS.connected
            )
              ? Effect.void
              : Effect.fail(new ConnectionCheckError({ reason: CONNECTION_CHECK_FAILURE.rejected }))
          )
        )
  }
)
