import {
  ModelCatalogResponseSchema,
  TranscribeInputSchema,
  TranscribeResponseSchema
} from "@arden-hq/protocol/effect/models"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"

export class ModelsApi extends HttpApiGroup.make("models", { topLevel: true })
  .add(
    HttpApiEndpoint.get("catalog", "/models", {
      success: ModelCatalogResponseSchema,
      error: [HttpApiError.InternalServerErrorNoContent]
    })
  )
  .add(
    HttpApiEndpoint.post("transcribe", "/transcribe", {
      payload: TranscribeInputSchema,
      success: TranscribeResponseSchema,
      error: [HttpApiError.ServiceUnavailableNoContent, HttpApiError.InternalServerErrorNoContent]
    })
  ) {}
