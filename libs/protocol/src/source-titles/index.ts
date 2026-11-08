import { decoderFor } from "../common/boundary.js"
import { SourceTitleResponseSchema } from "./schema.js"
export const sourceTitleRoute = "/source-titles"
export const decodeSourceTitle = decoderFor(SourceTitleResponseSchema, "Invalid source title")
export type { SourceMetadataInput, SourceMetadata } from "./schema.js"
