import { projectedDecoderFor } from "../common/boundary.js"
import {
  VisualizationListResponseSchema,
  VisualizationManifestResponseSchema,
  toVisualizationManifest
} from "./schema.js"

export * from "./contracts.js"

export const visualizationDecoders = {
  manifest: projectedDecoderFor(
    VisualizationManifestResponseSchema,
    toVisualizationManifest,
    "Invalid visualization manifest"
  ),
  list: projectedDecoderFor(
    VisualizationListResponseSchema,
    (manifests) => manifests.map(toVisualizationManifest),
    "Invalid visualization list"
  )
} as const
