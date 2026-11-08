import type { ModelCatalog as CatalogListing } from "@arden-hq/protocol/models"
import { Clock, Context, Effect, Schema, Scope, Semaphore } from "effect"
import { makeSettingsRuntime, type ModelSettingsRuntime } from "../persistence/models/settings.js"
import { decodeModelHost, type ModelHost, type ModelHostSource } from "./host.js"

export class ModelCatalogError extends Schema.TaggedError<ModelCatalogError>()(
  "ModelCatalogError",
  {
    reason: Schema.Literals(["invalid", "unavailable", "storage"] as const),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export type CatalogRefresh = "revalidate" | "fresh"

export class ModelCatalog extends Context.Service<
  ModelCatalog,
  {
    readonly catalog: (options?: {
      readonly refresh: CatalogRefresh
    }) => Effect.Effect<CatalogListing, ModelCatalogError>
    readonly runtime: () => Effect.Effect<ModelSettingsRuntime, ModelCatalogError>
    readonly installed: () => ModelSettingsRuntime
    readonly replaceHost: (source: ModelCatalogSource) => Effect.Effect<void, ModelCatalogError>
  }
>()("@arden-hq/server/models/ModelCatalog") {}

const CATALOG_MAX_AGE_MILLISECONDS = 10 * 60 * 1_000

const catalogError = (reason: ModelCatalogError["reason"], message: string) => (cause: unknown) =>
  new ModelCatalogError({ reason, message, cause })

export interface ModelCatalogSource {
  readonly host: ModelHostSource
  readonly refresh: (() => Promise<ModelHost>) | undefined
}

export interface ModelCatalogOptions {
  readonly host: ModelHostSource | undefined
  readonly refresh: (() => Promise<ModelHost>) | undefined
  readonly install: (runtime: ModelSettingsRuntime) => Effect.Effect<void, ModelCatalogError>
}

export const makeModelCatalog = Effect.fn("ModelCatalog.make")(function* (
  options: ModelCatalogOptions
): Effect.fn.Return<ModelCatalog["Service"], ModelCatalogError, Scope.Scope> {
  const { host, install } = options
  let refresh = options.refresh
  let pendingHost = host?.kind === "discovering" ? host.host : undefined
  let runtime = makeSettingsRuntime(host?.kind === "ready" ? host.host : undefined)
  let initialized = pendingHost === undefined
  let discoveredAt = yield* Clock.currentTimeMillis
  const permit = yield* Semaphore.make(1)
  const scope = yield* Scope.Scope
  yield* install(runtime)

  const installHost = Effect.fn("ModelCatalog.installHost")(function* (host: ModelHost) {
    const decoded = yield* decodeModelHost(host).pipe(
      Effect.mapError(catalogError("invalid", "Invalid model catalog"))
    )
    const next = makeSettingsRuntime(decoded)
    yield* install(next)
    runtime = next
    initialized = true
    discoveredAt = yield* Clock.currentTimeMillis
  })
  const ensureRuntime = Effect.fn("ModelCatalog.runtime")(function* () {
    if (initialized || pendingHost === undefined) return runtime
    yield* permit.withPermit(
      Effect.gen(function* () {
        const pending = pendingHost
        if (initialized || pending === undefined) return
        const discovered = Effect.tryPromise({
          try: () => pending,
          catch: catalogError("unavailable", "Model discovery failed")
        })
        const retryOnceAfterBootStall = (rediscoverHost: () => Promise<ModelHost>) =>
          discovered.pipe(
            Effect.catch(() =>
              Effect.tryPromise({
                try: rediscoverHost,
                catch: catalogError("unavailable", "Model discovery failed")
              })
            )
          )
        const host = yield* refresh === undefined ? discovered : retryOnceAfterBootStall(refresh)
        yield* installHost(host)
      })
    )
    return runtime
  })
  const catalog = Effect.fn("ModelCatalog.catalog")(function* (options?: {
    readonly refresh: CatalogRefresh
  }) {
    const rediscoverHost = refresh
    if (options === undefined || rediscoverHost === undefined) {
      return (yield* ensureRuntime()).catalog
    }
    const rediscover = Effect.gen(function* () {
      const host = yield* Effect.tryPromise({
        try: rediscoverHost,
        catch: catalogError("unavailable", "Could not refresh the model catalog")
      })
      yield* installHost(host)
    })
    if (options.refresh === "fresh" || !initialized || !runtime.available) {
      yield* permit.withPermit(rediscover)
      return runtime.catalog
    }
    if ((yield* Clock.currentTimeMillis) - discoveredAt > CATALOG_MAX_AGE_MILLISECONDS) {
      yield* Effect.forkIn(
        permit
          .withPermitsIfAvailable(1)(rediscover)
          .pipe(Effect.ignore({ log: "Warn", message: "Could not refresh the model catalog" })),
        scope
      )
    }
    return runtime.catalog
  })
  const replaceHost = Effect.fn("ModelCatalog.replaceHost")(function* (source: ModelCatalogSource) {
    yield* permit.withPermit(
      Effect.gen(function* () {
        refresh = source.refresh
        if (source.host.kind === "discovering") {
          pendingHost = source.host.host
          initialized = false
          return
        }
        pendingHost = undefined
        yield* installHost(source.host.host)
      })
    )
  })
  return ModelCatalog.of({ catalog, runtime: ensureRuntime, installed: () => runtime, replaceHost })
})
