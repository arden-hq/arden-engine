import type { PauseRequested } from "@arden-hq/loop"
import { Effect } from "effect"

import {
  ConnectionCheckError,
  requestConnection,
  type ConnectionCheck
} from "../connections/recovery.js"
import { McpConnections } from "./service.js"

export const mcpConnectionPause = (serverName: string, detail: string): PauseRequested =>
  requestConnection({
    provider: "mcp",
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
              (server) => server.name === decision.service && server.status === "connected"
            )
              ? Effect.void
              : Effect.fail(new ConnectionCheckError({ reason: "rejected" }))
          )
        )
  }
)
