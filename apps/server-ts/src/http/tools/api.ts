import { ToolCatalogResponseSchema } from "@arden-hq/protocol/effect/tools"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"

export class ToolsApi extends HttpApiGroup.make("tools", { topLevel: true }).add(
  HttpApiEndpoint.get("catalog", "/tools", {
    success: ToolCatalogResponseSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  })
) {}
