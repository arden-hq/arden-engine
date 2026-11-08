import { ModelResetRequestSchema } from "@arden-hq/protocol/effect/models"
import { ConfigPatchRequestSchema, ConfigResponseSchema } from "@arden-hq/protocol/effect/config"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import { storeErrors } from "../errors.js"

export class ConfigApi extends HttpApiGroup.make("config", { topLevel: true }).add(
  HttpApiEndpoint.get("settings", "/config", {
    success: ConfigResponseSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.patch("updateSettings", "/config", {
    payload: ConfigPatchRequestSchema,
    success: ConfigResponseSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.post("resetModelSettings", "/config/models/reset", {
    payload: ModelResetRequestSchema,
    success: ConfigResponseSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  })
) {}
