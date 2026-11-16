import {
  ChatEndpointCheckResponseSchema,
  ChatEndpointDraftRequestSchema,
  ChatEndpointSaveResponseSchema,
  DecisionSourceRequestSchema,
  DecisionStatusResponseSchema,
  ModelEndpointCheckResponseSchema,
  ModelEndpointDraftRequestSchema,
  ModelEndpointRouteKindSchema,
  ModelEndpointSaveResponseSchema,
  ModelEndpointsResponseSchema
} from "@arden-hq/protocol/effect/model-endpoints"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"

const errors = [
  HttpApiError.BadRequestNoContent,
  HttpApiError.UnprocessableEntityNoContent,
  HttpApiError.InternalServerErrorNoContent
] as const
const params = { kind: ModelEndpointRouteKindSchema }
/** `search` and `decision` take the endpoint draft, `chat` the model server's; the kind decides. */
const draft = Schema.Union([ModelEndpointDraftRequestSchema, ChatEndpointDraftRequestSchema])

export class ModelEndpointsApi extends HttpApiGroup.make("modelEndpoints", { topLevel: true }).add(
  HttpApiEndpoint.get("list", "/model-endpoints", {
    success: ModelEndpointsResponseSchema,
    error: errors
  }),
  HttpApiEndpoint.put("save", "/model-endpoints/:kind", {
    params,
    payload: draft,
    success: Schema.Union([ModelEndpointSaveResponseSchema, ChatEndpointSaveResponseSchema]),
    error: errors
  }),
  HttpApiEndpoint.delete("remove", "/model-endpoints/:kind", {
    params,
    success: ModelEndpointsResponseSchema,
    error: errors
  }),
  HttpApiEndpoint.post("check", "/model-endpoints/:kind/check", {
    params,
    payload: draft,
    success: Schema.Union([ModelEndpointCheckResponseSchema, ChatEndpointCheckResponseSchema]),
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
