import { makeEncoder, projectedDecoderFor } from "../common/boundary.js"
import type { DecisionSource, ModelEndpointDraft, ModelEndpointKind } from "./contracts.js"
import {
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
  /** `GET /decisions/status` and `PUT /decisions/source`. */
  decisionStatus: projectedDecoderFor(
    DecisionStatusResponseSchema,
    mapDecisionStatus,
    "Invalid decision status"
  )
} as const

export const modelEndpointRequests = {
  draft: makeEncoder<ModelEndpointDraft>(encodeModelEndpointDraftEffect, "Invalid model endpoint"),
  decisionSource: makeEncoder<DecisionSource>(encodeDecisionSourceEffect, "Invalid decision source")
} as const

export const modelEndpointRoutes = {
  list: "/model-endpoints",
  endpoint: (kind: ModelEndpointKind) => `/model-endpoints/${kind}`,
  check: (kind: ModelEndpointKind) => `/model-endpoints/${kind}/check`,
  decisionStatus: "/decisions/status",
  decisionSource: "/decisions/source"
} as const
