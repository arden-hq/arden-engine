import { decoderFor } from "../common/boundary.js"
import { SourceTitleResponseSchema } from "./schema.js"
export const sourceTitleRoute = "/source-titles"
export const decodeSourceTitle = decoderFor(SourceTitleResponseSchema, "Invalid source title")
export type {
  SourceLink,
  SourceMetadataInput,
  SourceMetadata,
  SourceMetadataStatus,
  SourceUnavailable
} from "./schema.js"
export {
  SOURCE_DATE,
  SOURCE_INPUT,
  SOURCE_LINK,
  SOURCE_METADATA_STATUS,
  SOURCE_UNAVAILABLE
} from "./schema.js"
