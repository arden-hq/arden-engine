import {
  MODEL_ENDPOINT_SLOT,
  type ModelEndpoint,
  type ModelEndpointKind,
  type ModelEndpoints,
  type ModelEndpointSlot
} from "@arden-hq/protocol/model-endpoints"
import type {
  ModelEndpointSettings,
  StoredEndpoint
} from "../../persistence/model-endpoints/store.js"
import { viewAll as chatViews } from "./chat-service.js"

export const view = (kind: ModelEndpointKind, stored: StoredEndpoint): ModelEndpoint => ({
  kind,
  baseUrl: stored.baseUrl,
  format: stored.format,
  model: stored.model,
  input: stored.input,
  auth: stored.auth,
  health: stored.health
})

const slot = (kind: ModelEndpointKind, stored: StoredEndpoint | null): ModelEndpointSlot =>
  stored === null
    ? { state: MODEL_ENDPOINT_SLOT.unset }
    : { state: MODEL_ENDPOINT_SLOT.saved, endpoint: view(kind, stored) }

export const viewAll = (saved: ModelEndpointSettings): ModelEndpoints => ({
  search: slot("search", saved.search),
  decision: slot("decision", saved.decision),
  chat: chatViews(saved.chat)
})
