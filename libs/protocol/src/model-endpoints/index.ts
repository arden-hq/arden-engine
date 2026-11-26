import { makeEncoder, projectedDecoderFor, runBoundary } from "../common/boundary.js"
import type {
  ChatEndpointDraft,
  DecisionSource,
  ModelEndpointDraft,
  ModelEndpointKind
} from "./contracts.js"
import {
  ChatEndpointCheckResponseSchema,
  ChatEndpointSaveResponseSchema,
  encodeChatEndpointDraftEffect,
  encodeChatEndpointPathEffect,
  mapChatEndpointCheck,
  mapChatEndpointSave,
  encodeModelEndpointDraftEffect,
  mapModelEndpointCheck,
  mapModelEndpoints,
  mapModelEndpointSave,
  ModelEndpointCheckResponseSchema,
  ModelEndpointSaveResponseSchema,
  ModelEndpointsResponseSchema
} from "./schema.js"
import {
  DecisionStatusResponseSchema,
  encodeDecisionSourceEffect,
  mapDecisionStatus
} from "./decision-schema.js"

export * from "./contracts.js"

export const modelEndpointDecoders = {
  endpoints: projectedDecoderFor(
    ModelEndpointsResponseSchema,
    mapModelEndpoints,
    "Invalid model endpoints"
  ),
  save: projectedDecoderFor(
    ModelEndpointSaveResponseSchema,
    mapModelEndpointSave,
    "Invalid model endpoint save result"
  ),
  check: projectedDecoderFor(
    ModelEndpointCheckResponseSchema,
    mapModelEndpointCheck,
    "Invalid model endpoint check"
  ),
  chatSave: projectedDecoderFor(
    ChatEndpointSaveResponseSchema,
    mapChatEndpointSave,
    "Invalid model server save result"
  ),
  chatCheck: projectedDecoderFor(
    ChatEndpointCheckResponseSchema,
    mapChatEndpointCheck,
    "Invalid model server check"
  ),
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

const chatServerPath = (id: string): string =>
  runBoundary(encodeChatEndpointPathEffect(id), "Invalid model server route", "encode")

export const modelEndpointRoutes = {
  list: "/model-endpoints",
  endpoint: (kind: ModelEndpointKind) => `/model-endpoints/${kind}`,
  check: (kind: ModelEndpointKind) => `/model-endpoints/${kind}/check`,
  chatServers: "/model-endpoints/chat",
  chatServer: chatServerPath,
  chatCheck: "/model-endpoints/chat/check",
  chatServerCheck: (id: string) => `${chatServerPath(id)}/check`,
  decisionStatus: "/decisions/status",
  decisionSource: "/decisions/source"
} as const
