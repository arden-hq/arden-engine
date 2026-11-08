import {
  ContextExperimentParamsSchema,
  ContextExperimentReportSchema,
  ContextSelectionSchema
} from "@arden-hq/protocol/effect/context"
import {
  ContextCompactionRequestSchema,
  ContextCompactionResponseSchema
} from "@arden-hq/protocol/effect/context"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import { storeErrors } from "../errors.js"

export class ContextApi extends HttpApiGroup.make("context", { topLevel: true }).add(
  HttpApiEndpoint.get("experiments", "/context/experiments/:sessionId", {
    params: ContextExperimentParamsSchema,
    success: ContextExperimentReportSchema,
    error: [HttpApiError.Forbidden]
  }),
  HttpApiEndpoint.put("selectContext", "/context/experiments/:sessionId", {
    params: ContextExperimentParamsSchema,
    payload: ContextSelectionSchema.annotate({ parseOptions: { onExcessProperty: "error" } }),
    success: ContextExperimentReportSchema,
    error: [HttpApiError.Forbidden, HttpApiError.BadRequestNoContent]
  }),
  HttpApiEndpoint.post("compact", "/compact", {
    payload: ContextCompactionRequestSchema,
    success: ContextCompactionResponseSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  })
) {}
