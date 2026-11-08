import { HealthResponseSchema } from "@arden-hq/protocol/effect/health"
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"

export class HealthApi extends HttpApiGroup.make("health", { topLevel: true }).add(
  HttpApiEndpoint.get("health", "/health", {
    success: HealthResponseSchema
  })
) {}
