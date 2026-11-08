import { Context, Effect, Exit, Layer, Schema, Scope } from "effect"
import * as Http from "effect/unstable/http"
import type { HostedServerOptions } from "../config/options.js"
import { ServerConfig, layer } from "../config/service.js"
import { serverLayer } from "../http/server.js"
import { ChatMessage } from "../chat/message.js"
import { ServerLifecycle } from "./lifecycle.js"
import type { ModelProviderSwitch } from "../models/provider-switch.js"
import { decodeModelHostSource } from "../models/host.js"
import { Diagnostics, diagnosticsLayer } from "./diagnostics.js"

export interface OpenServer {
  readonly address: Http.HttpServer.TcpAddress
  readonly scope: Scope.Closeable
  readonly context: Context.Context<ChatMessage | ModelProviderSwitch>
}

const decodeLocalAccess = Schema.decodeUnknownEffect(
  Schema.UndefinedOr(
    Schema.Struct({
      capability: Schema.String.check(Schema.isMinLength(32)),
      rendererOrigin: Schema.String.check(Schema.isMinLength(1)),
      cliCapability: Schema.String.check(Schema.isMinLength(32))
    })
  )
)

export const openServer = (options: HostedServerOptions, scope: Scope.Closeable) =>
  Effect.gen(function* () {
    const configContext = yield* Layer.buildWithScope(layer(options), scope)
    const config = Context.get(configContext, ServerConfig)
    const modelHost = yield* decodeModelHostSource(options.modelHost)
    const localAccess = yield* decodeLocalAccess(options.localAccess)
    const context = yield* Layer.buildWithScope(
      serverLayer(config, { ...options, modelHost, localAccess }),
      scope
    )
    const server = Context.get(context, Http.HttpServer.HttpServer)

    if (server.address._tag !== "TcpAddress") {
      return yield* Effect.fail(new Error("Arden server requires a TCP listener"))
    }

    yield* Context.get(context, ServerLifecycle).ready
    yield* Diagnostics.use((diagnostics) => diagnostics.startupPhase("http_ready"))

    return {
      address: server.address,
      scope,
      context
    }
  }).pipe(
    Effect.provide(
      options.diagnostics === undefined ? Layer.empty : diagnosticsLayer(options.diagnostics)
    )
  )

export const closeServer = (server: OpenServer) => Scope.close(server.scope, Exit.void)
