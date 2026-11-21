import { toModelSettingsPatch } from "@arden-hq/protocol/effect/models"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ModelCatalog, ModelCatalogError } from "../../models/catalog.js"
import { ModelStore, ModelStoreError } from "../../persistence/models/store.js"
import { ArdenApi } from "../api.js"
import { failInternal, storeErrorToHttp } from "../errors.js"
import { modelSettingsResponse } from "../models/handlers.js"

export const ConfigHandlers = HttpApiBuilder.group(
  ArdenApi,
  "config",
  Effect.fn(function* (handlers) {
    const modelCatalog = yield* ModelCatalog
    const models = yield* ModelStore

    const read = Effect.fn("ConfigHandlers.read")(function* () {
      const [catalog, settings] = yield* Effect.all([modelCatalog.catalog(), models.snapshot()])
      return modelSettingsResponse(catalog, settings)
    })

    return handlers
      .handle("settings", () => read().pipe(Effect.catch(failInternal("Model settings"))))
      .handle("updateSettings", ({ payload }) =>
        Effect.gen(function* () {
          yield* models.patch(toModelSettingsPatch(payload))
          return yield* read()
        }).pipe(
          Effect.catchTags({
            ModelCatalogError: (error) => Effect.fail(storeErrorToHttp(error)),
            ModelStoreError: (error) => Effect.fail(storeErrorToHttp(error))
          })
        )
      )
      .handle("resetModelSettings", ({ payload }) =>
        models.reset(payload.scope).pipe(
          Effect.flatMap(() => read()),
          Effect.catch((error) =>
            error instanceof ModelCatalogError || error instanceof ModelStoreError
              ? Effect.fail(storeErrorToHttp(error))
              : failInternal("Model settings reset")(error)
          )
        )
      )
  })
)
