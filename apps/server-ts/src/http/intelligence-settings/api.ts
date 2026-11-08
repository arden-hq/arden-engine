import {
  IntelligenceSettingsPatchRequestSchema,
  IntelligenceSettingsResponseSchema
} from "@arden-hq/protocol/effect/settings"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import { storeErrors } from "../errors.js"

export class IntelligenceSettingsApi extends HttpApiGroup.make("intelligenceSettings", {
  topLevel: true
}).add(
  HttpApiEndpoint.get("settings", "/settings/intelligence", {
    success: IntelligenceSettingsResponseSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.patch("updateSettings", "/settings/intelligence", {
    payload: IntelligenceSettingsPatchRequestSchema,
    success: IntelligenceSettingsResponseSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  })
) {}
