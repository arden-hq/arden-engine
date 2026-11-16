import {
  ChatEndpointCheckResponseSchema,
  ChatEndpointDraftRequestSchema,
  ChatEndpointIdSchema,
  ChatEndpointSaveResponseSchema,
  DecisionSourceRequestSchema,
  DecisionStatusResponseSchema,
  ModelEndpointCheckResponseSchema,
  ModelEndpointDraftRequestSchema,
  ModelEndpointKindSchema,
  ModelEndpointSaveResponseSchema,
  ModelEndpointsResponseSchema
} from "@arden-hq/protocol/effect/model-endpoints"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"

/** Not found: no saved model server has the id. */
const errors = [
  HttpApiError.BadRequestNoContent,
  HttpApiError.NotFoundNoContent,
  HttpApiError.UnprocessableEntityNoContent,
  HttpApiError.InternalServerErrorNoContent
] as const
const params = { kind: ModelEndpointKindSchema }
const chatParams = { id: ChatEndpointIdSchema }

export class ModelEndpointsApi extends HttpApiGroup.make("modelEndpoints", { topLevel: true }).add(
  HttpApiEndpoint.get("list", "/model-endpoints", {
    success: ModelEndpointsResponseSchema,
    error: errors
  }),
  // The model servers are a collection under `/model-endpoints/chat`. Its
  // static `check` segment wins over `:kind/check`, and `check` is never an id.
  HttpApiEndpoint.post("addChat", "/model-endpoints/chat", {
    payload: ChatEndpointDraftRequestSchema,
    success: ChatEndpointSaveResponseSchema,
    error: errors
  }),
  HttpApiEndpoint.post("checkChat", "/model-endpoints/chat/check", {
    payload: ChatEndpointDraftRequestSchema,
    success: ChatEndpointCheckResponseSchema,
    error: errors
  }),
  HttpApiEndpoint.put("replaceChat", "/model-endpoints/chat/:id", {
    params: chatParams,
    payload: ChatEndpointDraftRequestSchema,
    success: ChatEndpointSaveResponseSchema,
    error: errors
  }),
  HttpApiEndpoint.delete("removeChat", "/model-endpoints/chat/:id", {
    params: chatParams,
    success: ModelEndpointsResponseSchema,
    error: errors
  }),
  HttpApiEndpoint.post("checkChatEdit", "/model-endpoints/chat/:id/check", {
    params: chatParams,
    payload: ChatEndpointDraftRequestSchema,
    success: ChatEndpointCheckResponseSchema,
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
