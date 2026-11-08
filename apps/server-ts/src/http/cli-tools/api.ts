import { CliToolsReportSchema } from "@arden-hq/protocol/effect/cli-tools"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"

export class CliToolsApi extends HttpApiGroup.make("cliTools", { topLevel: true }).add(
  HttpApiEndpoint.get("list", "/cli-tools", {
    success: CliToolsReportSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.post("refresh", "/cli-tools/refresh", {
    success: CliToolsReportSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  })
) {}
