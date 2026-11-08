import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import {
  SourceTitleRequestSchema,
  SourceTitleResponseSchema
} from "@arden-hq/protocol/effect/source-titles"
export class SourceTitlesApi extends HttpApiGroup.make("sourceTitles", { topLevel: true }).add(
  HttpApiEndpoint.post("readSourceTitle", "/source-titles", {
    payload: SourceTitleRequestSchema,
    success: SourceTitleResponseSchema
  })
) {}
