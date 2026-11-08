import { makeEncoder, projectedDecoderFor } from "../common/boundary.js"
import type { EmbeddingModelChoice } from "./contracts.js"
import {
  EmbeddingIndexStatusResponseSchema,
  encodeEmbeddingModelChoiceEffect,
  mapStatus
} from "./schema.js"

export * from "./contracts.js"

export const embeddingDecoders = {
  status: projectedDecoderFor(
    EmbeddingIndexStatusResponseSchema,
    mapStatus,
    "Invalid embedding index status"
  )
} as const

export const embeddingRequests = {
  model: makeEncoder<EmbeddingModelChoice>(
    encodeEmbeddingModelChoiceEffect,
    "Invalid embedding model choice"
  )
} as const

/** Every route answers with the embedding index status. */
export const embeddingRoutes = {
  status: "/embeddings/status",
  model: "/embeddings/model",
  pause: "/embeddings/pause",
  resume: "/embeddings/resume",
  cancel: "/embeddings/cancel"
} as const
