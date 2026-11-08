import { Context, Effect, Layer, type Schema } from "effect"
import type { ModelProviderOptions } from "../config/options.js"
import { ModelCatalog, type ModelCatalogError } from "./catalog.js"
import { decodeModelHostSource } from "./host.js"
import { ModelProviderService } from "./provider.js"

export class ModelProviderSwitch extends Context.Service<
  ModelProviderSwitch,
  {
    readonly replace: (
      next: ModelProviderOptions
    ) => Effect.Effect<void, Schema.SchemaError | ModelCatalogError>
  }
>()("@arden-hq/server/models/ModelProviderSwitch") {
  static readonly layer = Layer.effect(
    ModelProviderSwitch,
    Effect.gen(function* () {
      const catalog = yield* ModelCatalog
      const models = yield* ModelProviderService
      const replace = Effect.fn("ModelProviderSwitch.replace")(function* (
        next: ModelProviderOptions
      ) {
        const host = yield* decodeModelHostSource(next.modelHost)
        yield* catalog.replaceHost({ host, refresh: next.refreshModelHost })
        yield* models.replace({
          provider: next.provider,
          planLimits: next.planLimits,
          approvalReview: next.approvalReview,
          transcription: next.transcription,
          structuredOutputDialect: next.structuredOutputDialect
        })
      })
      return ModelProviderSwitch.of({ replace })
    })
  )
}
