import { MCP_CONNECTION_STATUS } from "@arden-hq/protocol/mcp"
import { Effect, Layer } from "effect"
import type { ConnectedServer } from "../persistence/capability-offers/match.js"
import { CapabilityOfferStore } from "../persistence/capability-offers/store.js"
import { McpConnections } from "./service.js"
import { connectedServer } from "./public-server.js"

export const capabilityOfferRuntime: Layer.Layer<
  never,
  never,
  McpConnections | CapabilityOfferStore
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const mcp = yield* McpConnections
    const offers = yield* CapabilityOfferStore
    const answer = (server: ConnectedServer) =>
      offers.connected(server).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not answer connection cards", { cause })
        ),
        Effect.asVoid
      )
    const stop = mcp.onConnected((server) => Effect.runFork(answer(server)))
    yield* Effect.addFinalizer(() => Effect.sync(stop))
    const servers = yield* mcp.snapshot()
    yield* Effect.forEach(
      servers.filter((server) => server.status === MCP_CONNECTION_STATUS.connected),
      (server) => answer(connectedServer(server)),
      { discard: true }
    )
  })
)
