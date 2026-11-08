import type { ModelCatalog as CatalogListing } from "@arden-hq/protocol/models"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { ModelCatalog } from "../../models/catalog.js"
import { ModelProviderService } from "../../models/provider.js"
import type { ModelSettingsSnapshot } from "../../persistence/models/store.js"
import { ArdenApi } from "../api.js"

const internalError = () => new HttpApiError.InternalServerError({})

const catalogResponse = (catalog: CatalogListing) => {
  const models = catalog.providers.flatMap((provider) => provider.models)
  return {
    models: models.map((model) => model.id),
    names: Object.fromEntries(models.map((model) => [model.id, model.name])),
    groups: catalog.providers.flatMap((provider) => {
      const [first, ...rest] = provider.models.map((model) => model.id)
      return first === undefined
        ? []
        : [
            {
              provider: provider.id,
              label: provider.name,
              models: [first, ...rest] as const
            }
          ]
    }),
    reasoning_efforts: Object.fromEntries(
      models.map((model) => [model.id, [...model.reasoningEfforts]])
    )
  }
}

export const modelSettingsResponse = (catalog: CatalogListing, settings: ModelSettingsSnapshot) => {
  const chatModel = catalog.providers
    .flatMap((provider) => provider.models)
    .find((model) => model.id === settings.chatModelId)
  const role = settings.effective.roles
  const efforts = chatModel === undefined ? [] : [...chatModel.reasoningEfforts]
  const saved = settings.effective.chat.reasoningEffort
  const offered = saved !== null && efforts.includes(saved) ? saved : null
  const modelEfforts = { ...settings.modelReasoningEfforts }
  if (offered === null && settings.chatModelId !== null) delete modelEfforts[settings.chatModelId]
  return {
    chat_model: settings.chatModelId,
    at_defaults: settings.atDefaults,
    reasoning_effort: offered,
    reasoning_efforts: efforts,
    model_reasoning_efforts: modelEfforts,
    model_roles: {
      background: {
        model: role.background.modelId,
        reasoning_effort: role.background.reasoningEffort
      },
      helper: {
        model: role.helper.modelId,
        reasoning_effort: role.helper.reasoningEffort
      }
    }
  }
}

export const ModelHandlers = HttpApiBuilder.group(
  ArdenApi,
  "models",
  Effect.fn(function* (handlers) {
    const catalog = yield* ModelCatalog
    const models = yield* ModelProviderService
    return handlers
      .handle("catalog", () =>
        catalog
          .catalog({ refresh: "revalidate" })
          .pipe(Effect.map(catalogResponse), Effect.mapError(internalError))
      )
      .handle("transcribe", ({ payload }) => {
        const transcription = models.current()?.transcription
        if (transcription === undefined) return Effect.fail(new HttpApiError.ServiceUnavailable({}))
        return Effect.tryPromise({
          try: (signal) =>
            transcription.transcribe(
              { bytes: payload.data, mediaType: payload.media_type },
              signal
            ),
          catch: (cause) => cause
        }).pipe(
          Effect.map((text) => ({ text })),
          Effect.tapError((cause) => Effect.logWarning("Transcription failed", { cause })),
          Effect.mapError(internalError)
        )
      })
  })
)
