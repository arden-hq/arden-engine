import { Context, Effect, Layer, RcMap, type Scope } from "effect"

import { EmbeddingModel, EmbeddingModelError } from "./model.js"

export interface EmbeddingModelEntry {
  readonly modelId: string
  readonly indexVersion: string
  readonly dimensions: number
}

export interface EmbeddingModelSource extends EmbeddingModelEntry {
  readonly layer: Layer.Layer<EmbeddingModel, EmbeddingModelError>
  readonly available?: () => Effect.Effect<boolean>
}

export class EmbeddingModels extends Context.Service<
  EmbeddingModels,
  {
    readonly catalog: () => Effect.Effect<ReadonlyArray<EmbeddingModelEntry>>
    readonly use: (
      modelId: string
    ) => Effect.Effect<EmbeddingModel["Service"], EmbeddingModelError, Scope.Scope>
    readonly release: (modelId: string) => Effect.Effect<void>
    readonly register: (source: EmbeddingModelSource) => Effect.Effect<void>
    readonly unregister: (modelId: string) => Effect.Effect<void>
  }
>()("@arden-hq/server/embedding/EmbeddingModels") {}

const unknownModel = (modelId: string) =>
  new EmbeddingModelError({ operation: "load", message: `${modelId} is not installed` })

export const embeddingModelsLayer = (
  sources: ReadonlyArray<EmbeddingModelSource>
): Layer.Layer<EmbeddingModels> =>
  Layer.effect(
    EmbeddingModels,
    Effect.gen(function* () {
      const byId = new Map(sources.map((source) => [source.modelId, source] as const))
      const isAvailable = (source: EmbeddingModelSource) =>
        source.available === undefined ? Effect.succeed(true) : source.available()
      const loaded = yield* RcMap.make({
        lookup: (modelId: string) => {
          const source = byId.get(modelId)
          if (source === undefined) return Effect.fail(unknownModel(modelId))
          return isAvailable(source).pipe(
            Effect.flatMap((available) =>
              available
                ? Layer.build(source.layer).pipe(Effect.map(Context.get(EmbeddingModel)))
                : Effect.fail(unknownModel(modelId))
            )
          )
        },
        idleTimeToLive: Infinity
      })
      const release = (modelId: string) => RcMap.invalidate(loaded, modelId)
      return EmbeddingModels.of({
        catalog: () =>
          Effect.filter([...byId.values()], isAvailable).pipe(
            Effect.map((available) =>
              available.map((source): EmbeddingModelEntry => ({
                modelId: source.modelId,
                indexVersion: source.indexVersion,
                dimensions: source.dimensions
              }))
            )
          ),
        use: (modelId) => RcMap.get(loaded, modelId),
        release,
        register: (source) =>
          release(source.modelId).pipe(
            Effect.andThen(Effect.sync(() => byId.set(source.modelId, source)))
          ),
        unregister: (modelId) =>
          Effect.sync(() => byId.delete(modelId)).pipe(Effect.andThen(release(modelId)))
      })
    })
  )
