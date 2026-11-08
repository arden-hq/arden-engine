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

/**
 * Every route answers with the whole status. Settings polls `status` (about
 * once a second while a download runs). `install` starts or resumes a
 * download (a no-op when installed), `stop` keeps the bytes so far, `remove`
 * deletes the model's files (409 while the model is in use for search).
 * An unknown id answers 404.
 */
export const localModelsRoutes = {
  status: "/local-models",
  install: (id: string) => `/local-models/${encodeURIComponent(id)}/install`,
  stop: (id: string) => `/local-models/${encodeURIComponent(id)}/stop`,
  remove: (id: string) => `/local-models/${encodeURIComponent(id)}`
} as const
