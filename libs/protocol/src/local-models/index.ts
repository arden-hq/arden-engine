import { projectedDecoderFor } from "../common/boundary.js"
import { LocalModelsStatusResponseSchema, mapLocalModelsStatus } from "./schema.js"

export * from "./contracts.js"

export const localModelsDecoders = {
  status: projectedDecoderFor(
    LocalModelsStatusResponseSchema,
    mapLocalModelsStatus,
    "Invalid local models status"
  )
} as const

export const localModelsRoutes = {
  status: "/local-models",
  install: (id: string) => `/local-models/${encodeURIComponent(id)}/install`,
  stop: (id: string) => `/local-models/${encodeURIComponent(id)}/stop`,
  remove: (id: string) => `/local-models/${encodeURIComponent(id)}`
} as const
