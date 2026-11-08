import {
  DecisionSourceRequestSchema,
  DecisionStatusResponseSchema,
  ModelEndpointCheckResponseSchema,
  ModelEndpointDraftRequestSchema,
  ModelEndpointKindSchema,
  ModelEndpointSaveResponseSchema,
  ModelEndpointsResponseSchema
} from "@arden-hq/protocol/effect/model-endpoints"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"

const errors = [
  HttpApiError.BadRequestNoContent,
  HttpApiError.UnprocessableEntityNoContent,
  HttpApiError.InternalServerErrorNoContent
] as const
const params = { kind: ModelEndpointKindSchema }

export class ModelEndpointsApi extends HttpApiGroup.make("modelEndpoints", { topLevel: true }).add(
  HttpApiEndpoint.get("list", "/model-endpoints", {
    success: ModelEndpointsResponseSchema,
    error: errors
  }),
  HttpApiEndpoint.put("save", "/model-endpoints/:kind", {
    params,
    payload: ModelEndpointDraftRequestSchema,
    success: ModelEndpointSaveResponseSchema,
    error: errors
  }),
  HttpApiEndpoint.delete("remove", "/model-endpoints/:kind", {
    params,
    success: ModelEndpointsResponseSchema,
    error: errors
  }),
  HttpApiEndpoint.post("check", "/model-endpoints/:kind/check", {
    params,
    payload: ModelEndpointDraftRequestSchema,
    success: ModelEndpointCheckResponseSchema,
    error: errors
  }),
  HttpApiEndpoint.get("decisionStatus", "/decisions/status", {
    success: DecisionStatusResponseSchema,
    error: errors
  }),
  HttpApiEndpoint.put("decisionSource", "/decisions/source", {
    payload: DecisionSourceRequestSchema,
    success: DecisionStatusResponseSchema,
    error: errors
  })
) {}
