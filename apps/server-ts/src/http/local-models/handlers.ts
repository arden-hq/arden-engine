import { localModelsStatusResponse } from "@arden-hq/protocol/effect/local-models"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"

import { LocalModels } from "../../local-models/service.js"
import { ArdenApi } from "../api.js"

const notFound = () => new HttpApiError.NotFound({})

export const LocalModelHandlers = HttpApiBuilder.group(
  ArdenApi,
  "localModels",
  Effect.fn(function* (handlers) {
    const models = yield* LocalModels
    return handlers
      .handle("status", () => models.status().pipe(Effect.map(localModelsStatusResponse)))
      .handle("install", ({ params }) =>
        models.install(params.id).pipe(
          Effect.map(localModelsStatusResponse),
          Effect.catchTag("LocalModelNotFound", () => Effect.fail(notFound()))
        )
      )
      .handle("stop", ({ params }) =>
        models.stop(params.id).pipe(
          Effect.map(localModelsStatusResponse),
          Effect.catchTag("LocalModelNotFound", () => Effect.fail(notFound()))
        )
      )
      .handle("remove", ({ params }) =>
        models.remove(params.id).pipe(
          Effect.map(localModelsStatusResponse),
          Effect.catchTags({
            LocalModelNotFound: () => Effect.fail(notFound()),
            LocalModelInUse: () => Effect.fail(new HttpApiError.Conflict({})),
            LocalModelsError: (error) =>
              Effect.logWarning("Could not remove a local model", error).pipe(
                Effect.andThen(Effect.fail(new HttpApiError.InternalServerError({})))
              )
          })
        )
      )
  })
)
