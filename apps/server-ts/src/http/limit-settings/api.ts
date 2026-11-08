import {
  LimitSettingsPatchRequestSchema,
  LimitSettingsResponseSchema
} from "@arden-hq/protocol/effect/settings"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import { storeErrors } from "../errors.js"

export class LimitSettingsApi extends HttpApiGroup.make("limitSettings", { topLevel: true }).add(
  HttpApiEndpoint.get("settings", "/settings/limits", {
    success: LimitSettingsResponseSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.patch("updateSettings", "/settings/limits", {
    payload: LimitSettingsPatchRequestSchema,
    success: LimitSettingsResponseSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  })
) {}
