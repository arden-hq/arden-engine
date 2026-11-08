import {
  EmbeddingIndexStatusResponseSchema,
  EmbeddingModelChoiceRequestSchema
} from "@arden-hq/protocol/effect/embeddings"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"

const controlErrors = [
  HttpApiError.UnprocessableEntityNoContent,
  HttpApiError.ConflictNoContent,
  HttpApiError.InternalServerErrorNoContent
] as const

export class EmbeddingsApi extends HttpApiGroup.make("embeddings", { topLevel: true }).add(
  HttpApiEndpoint.get("status", "/embeddings/status", {
    success: EmbeddingIndexStatusResponseSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.put("setModel", "/embeddings/model", {
    payload: EmbeddingModelChoiceRequestSchema,
    success: EmbeddingIndexStatusResponseSchema,
    error: [HttpApiError.BadRequestNoContent, ...controlErrors]
  }),
  HttpApiEndpoint.post("pause", "/embeddings/pause", {
    success: EmbeddingIndexStatusResponseSchema,
    error: controlErrors
  }),
  HttpApiEndpoint.post("resume", "/embeddings/resume", {
    success: EmbeddingIndexStatusResponseSchema,
    error: controlErrors
  }),
  HttpApiEndpoint.post("cancel", "/embeddings/cancel", {
    success: EmbeddingIndexStatusResponseSchema,
    error: controlErrors
  })
) {}
