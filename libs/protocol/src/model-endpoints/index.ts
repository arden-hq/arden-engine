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
  /** `GET /model-endpoints`, `DELETE /model-endpoints/:kind` and `DELETE /model-endpoints/chat/:id`. */
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
  /** `POST /model-endpoints/chat` and `PUT /model-endpoints/chat/:id`. */
  chatSave: projectedDecoderFor(
    ChatEndpointSaveResponseSchema,
    mapChatEndpointSave,
    "Invalid model server save result"
  ),
  /** `POST /model-endpoints/chat/check` and `POST /model-endpoints/chat/:id/check`. */
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

const chatServerPath = (id: string): string =>
  runBoundary(encodeChatEndpointPathEffect(id), "Invalid model server route", "encode")

export const modelEndpointRoutes = {
  list: "/model-endpoints",
  endpoint: (kind: ModelEndpointKind) => `/model-endpoints/${kind}`,
  check: (kind: ModelEndpointKind) => `/model-endpoints/${kind}/check`,
  /** `POST` adds a model server. */
  chatServers: "/model-endpoints/chat",
  /** `PUT` replaces the saved server, `DELETE` removes it and its key. */
  chatServer: chatServerPath,
  /** `POST` checks a server that is not saved yet. */
  chatCheck: "/model-endpoints/chat/check",
  /** `POST` checks an edit of the saved server: its key for `keep`, its own models not taken. */
  chatServerCheck: (id: string) => `${chatServerPath(id)}/check`,
  decisionStatus: "/decisions/status",
  decisionSource: "/decisions/source"
} as const
