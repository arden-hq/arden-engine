import { LocalModelsStatusResponseSchema } from "@arden-hq/protocol/effect/local-models"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"

const params = { id: Schema.NonEmptyString }
const errors = [HttpApiError.NotFoundNoContent, HttpApiError.InternalServerErrorNoContent] as const

export class LocalModelsApi extends HttpApiGroup.make("localModels", { topLevel: true }).add(
  HttpApiEndpoint.get("status", "/local-models", {
    success: LocalModelsStatusResponseSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.post("install", "/local-models/:id/install", {
    params,
    success: LocalModelsStatusResponseSchema,
    error: errors
  }),
  HttpApiEndpoint.post("stop", "/local-models/:id/stop", {
    params,
    success: LocalModelsStatusResponseSchema,
    error: errors
  }),
  HttpApiEndpoint.delete("remove", "/local-models/:id", {
    params,
    success: LocalModelsStatusResponseSchema,
    error: [...errors, HttpApiError.ConflictNoContent]
  })
) {}
