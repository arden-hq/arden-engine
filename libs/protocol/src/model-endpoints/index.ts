import { makeEncoder, projectedDecoderFor } from "../common/boundary.js"
import type {
  ChatEndpointDraft,
  ChatEndpointKind,
  DecisionSource,
  ModelEndpointDraft,
  ModelEndpointKind
} from "./contracts.js"
import {
  ChatEndpointCheckResponseSchema,
  ChatEndpointSaveResponseSchema,
  encodeChatEndpointDraftEffect,
  mapChatEndpointCheck,
  mapChatEndpointSave,
  DecisionStatusResponseSchema,
  encodeDecisionSourceEffect,
  encodeModelEndpointDraftEffect,
  mapDecisionStatus,
  mapModelEndpointCheck,
  mapModelEndpoints,
  mapModelEndpointSave,
  ModelEndpointCheckResponseSchema,
  ModelEndpointSaveResponseSchema,
  ModelEndpointsResponseSchema
} from "./schema.js"

export * from "./contracts.js"

export const modelEndpointDecoders = {
  /** `GET /model-endpoints` and `DELETE /model-endpoints/:kind`. */
  endpoints: projectedDecoderFor(
    ModelEndpointsResponseSchema,
    mapModelEndpoints,
    "Invalid model endpoints"
  ),
  /** `PUT /model-endpoints/:kind`. */
  save: projectedDecoderFor(
    ModelEndpointSaveResponseSchema,
    mapModelEndpointSave,
    "Invalid model endpoint save result"
  ),
  /** `POST /model-endpoints/:kind/check`. */
  check: projectedDecoderFor(
    ModelEndpointCheckResponseSchema,
    mapModelEndpointCheck,
    "Invalid model endpoint check"
  ),
  /** `PUT /model-endpoints/chat`. */
  chatSave: projectedDecoderFor(
    ChatEndpointSaveResponseSchema,
    mapChatEndpointSave,
    "Invalid model server save result"
  ),
  /** `POST /model-endpoints/chat/check`. */
  chatCheck: projectedDecoderFor(
    ChatEndpointCheckResponseSchema,
    mapChatEndpointCheck,
    "Invalid model server check"
  ),
  /** `GET /decisions/status` and `PUT /decisions/source`. */
  decisionStatus: projectedDecoderFor(
    DecisionStatusResponseSchema,
    mapDecisionStatus,
    "Invalid decision status"
  )
} as const

export const modelEndpointRequests = {
  draft: makeEncoder<ModelEndpointDraft>(encodeModelEndpointDraftEffect, "Invalid model endpoint"),
  chatDraft: makeEncoder<ChatEndpointDraft>(encodeChatEndpointDraftEffect, "Invalid model server"),
  decisionSource: makeEncoder<DecisionSource>(encodeDecisionSourceEffect, "Invalid decision source")
} as const

export const modelEndpointRoutes = {
  list: "/model-endpoints",
  endpoint: (kind: ModelEndpointKind | ChatEndpointKind) => `/model-endpoints/${kind}`,
  check: (kind: ModelEndpointKind | ChatEndpointKind) => `/model-endpoints/${kind}/check`,
  decisionStatus: "/decisions/status",
  decisionSource: "/decisions/source"
} as const
