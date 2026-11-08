import { Effect, Layer } from "effect"
import { SessionLifecycleEvents } from "../persistence/sessions/events.js"
import { McpConnections } from "./service.js"

export const mcpChangeFeedRuntime: Layer.Layer<
  never,
  never,
  McpConnections | SessionLifecycleEvents
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const mcp = yield* McpConnections
    const events = yield* SessionLifecycleEvents
    const tell = (server: string) =>
      events.appendEvent({ type: "mcp_server_changed", server }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not tell clients a connection changed", { cause })
        ),
        Effect.asVoid
      )
    const stop = mcp.onChanged((server) => Effect.runFork(tell(server)))
    yield* Effect.addFinalizer(() => Effect.sync(stop))
    const servers = yield* mcp.snapshot()
    yield* Effect.forEach(servers, (server) => tell(server.name), { discard: true })
  })
)
