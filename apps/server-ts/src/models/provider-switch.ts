import {
  resolveModelCapabilities,
  type ModelProvider,
  type ModelProviderSession,
  MODEL_PROVIDER_PROTOCOL
} from "@arden-hq/loop"
import { ProviderError } from "@arden-hq/loop/provider-kit"
import { Context, Effect, Layer, Semaphore, type Schema } from "effect"
import type { ModelProviderOptions } from "../config/options.js"
import { ModelCatalog, type ModelCatalogError } from "./catalog.js"
import type { ServerModels } from "./endpoints/chat.js"
import { decodeModelHostSource, type ModelHost, type ModelHostSource } from "./host.js"
import { ModelProviderService, type ModelRouteInput } from "./provider.js"

/**
 * The model route and list in use, from two parts: the host's (the Codex
 * account in the app, a configured server's provider) and the saved model
 * servers'. Either can change while the server runs; each change installs
 * both together, so the list and the route always name the same models.
 */
export class ModelProviderSwitch extends Context.Service<
  ModelProviderSwitch,
  {
    /** The host's part: the Codex account signed in or out, or another provider. */
    readonly replace: (
      next: ModelProviderOptions
    ) => Effect.Effect<void, Schema.SchemaError | ModelCatalogError>
    /** The saved model servers' part, in the order they were added; empty when none is saved. */
    readonly replaceServers: (
      next: ReadonlyArray<ServerModels>
    ) => Effect.Effect<void, ModelCatalogError>
  }
>()("@arden-hq/server/models/ModelProviderSwitch") {
  static readonly layer = (initial: HostPart) =>
    Layer.effect(
      ModelProviderSwitch,
      Effect.gen(function* () {
        const catalog = yield* ModelCatalog
        const models = yield* ModelProviderService
        const permit = yield* Semaphore.make(1)
        let host = initial
        let servers: ReadonlyArray<ServerModels> = []
        const install = Effect.fn("ModelProviderSwitch.install")(function* () {
          const current = composed(host, servers)
          yield* catalog.replaceHost({ host: current.host, refresh: current.refresh })
          yield* models.replace(current.route)
        })
        const replace = Effect.fn("ModelProviderSwitch.replace")(function* (
          next: ModelProviderOptions
        ) {
          const source = yield* decodeModelHostSource(next.modelHost)
          yield* permit.withPermit(
            Effect.suspend(() => {
              host = {
                route: {
                  provider: next.provider,
                  planLimits: next.planLimits,
                  approvalReview: next.approvalReview,
                  transcription: next.transcription,
                  structuredOutputDialect: next.structuredOutputDialect
                },
                host: source,
                refresh: next.refreshModelHost
              }
              return install()
            })
          )
        })
        const replaceServers = (next: ReadonlyArray<ServerModels>) =>
          permit.withPermit(
            Effect.suspend(() => {
              servers = next
              return install()
            })
          )
        return ModelProviderSwitch.of({ replace, replaceServers })
      })
    )
}

/** What the host supplies: a route, its model list, and how to read the list again. */
export interface HostPart {
  readonly route: ModelRouteInput
  readonly host: ModelHostSource
  readonly refresh: (() => Promise<ModelHost>) | undefined
}

/**
 * The host's part alone when no server is saved, exactly as before a model
 * server existed. With some, their models follow the host's, server by
 * server; the host's defaults stand, and a list without a chat model (nobody
 * signed in to ChatGPT) starts new chats on the first server's first model.
 * ChatGPT-only features stay the host's, and its plan meters only its own
 * models.
 */
const composed = (part: HostPart, servers: ReadonlyArray<ServerModels>): HostPart => {
  if (servers.length === 0) return part
  const models = servers.flatMap((server) => server.models)
  const merge = (host: ModelHost): ModelHost => ({
    models: [...host.models, ...models],
    defaults:
      host.defaults.chatModelId === null && models[0] !== undefined
        ? { ...host.defaults, chatModelId: models[0].id }
        : host.defaults
  })
  const served = new Map(
    servers.flatMap((server) => server.models.map((model) => [model.id, server.provider] as const))
  )
  const refresh = part.refresh
  return {
    route: {
      ...part.route,
      provider: mixed(part.route.provider, served),
      planMeters: (model) => !served.has(model)
    },
    host: mergedSource(part.host, merge),
    refresh: refresh === undefined ? undefined : () => refresh().then(merge)
  }
}

const mergedSource = (
  source: ModelHostSource,
  merge: (host: ModelHost) => ModelHost
): ModelHostSource => {
  if (source.kind === "ready") return { kind: "ready", host: merge(source.host) }
  const host = source.host.then(merge)
  // The host's list may fail (no ChatGPT credential at start); the catalog
  // reads that failure when it asks, so it must never surface unhandled.
  void host.catch(() => undefined)
  return { kind: "discovering", host }
}

/**
 * One provider over both parts, picking by the request's model id: a saved
 * server's ids go to its adapters, every other id to the host's provider. A
 * host session is opened only for a host model, so a chat on a server never
 * waits on a ChatGPT sign-in.
 */
const mixed = (
  host: ModelProvider | undefined,
  served: ReadonlyMap<string, ModelProvider>
): ModelProvider => {
  const pick = (model: string): ModelProvider => {
    const server = served.get(model)
    if (server !== undefined) return server
    if (host === undefined)
      throw new ProviderError(`No signed-in account or model server serves ${model}`, {
        code: "model_unavailable",
        retryable: false
      })
    return host
  }
  const openSession = host?.openSession
  return {
    protocolVersion: MODEL_PROVIDER_PROTOCOL,
    capabilities: (model) => resolveModelCapabilities({ provider: pick(model), model }),
    stream: (request) => pick(request.model).stream(request),
    ...(openSession === undefined || host === undefined
      ? {}
      : {
          openSession: (): ModelProviderSession => {
            let opened: Promise<ModelProviderSession> | undefined
            const hostSession = async (): Promise<ModelProviderSession> => {
              opened ??= Promise.resolve(openSession()).then(
                (session) => session ?? { stream: host.stream, close: () => undefined }
              )
              return opened
            }
            return {
              stream: (request) =>
                served.has(request.model)
                  ? pick(request.model).stream(request)
                  : (async function* () {
                      yield* await (await hostSession()).stream(request)
                    })(),
              close: async () => {
                if (opened !== undefined) await (await opened).close()
              }
            }
          }
        })
  }
}
