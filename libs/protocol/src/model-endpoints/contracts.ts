import type { BaseUrlIssue } from "@arden-hq/std/url"
import type { JsonRecord } from "../common/json.js"
import type { MODEL_CALL_KIND } from "../runs/usage.js"

export const MODEL_ENDPOINT_KIND = { search: "search", decision: "decision" } as const

export type ModelEndpointKind = (typeof MODEL_ENDPOINT_KIND)[keyof typeof MODEL_ENDPOINT_KIND]

export const MODEL_ENDPOINT_FORMAT = {
  openaiEmbeddings: "openai-embeddings",
  openaiDecisions: "openai-decisions",
  systemone: "systemone",
  openrouterDecisions: "openrouter-decisions"
} as const

export type ModelEndpointFormat = (typeof MODEL_ENDPOINT_FORMAT)[keyof typeof MODEL_ENDPOINT_FORMAT]

export const MODEL_ENDPOINT_INPUT = { text: "text", textImage: "text+image" } as const

export type ModelEndpointInput = (typeof MODEL_ENDPOINT_INPUT)[keyof typeof MODEL_ENDPOINT_INPUT]

export const MODEL_ENDPOINT_AUTH = { bearer: "bearer", header: "header", keep: "keep" } as const

export type ModelEndpointAuthInput =
  | { readonly kind: typeof MODEL_ENDPOINT_AUTH.bearer; readonly apiKey: string }
  | {
      readonly kind: typeof MODEL_ENDPOINT_AUTH.header
      readonly name: string
      readonly value: string
    }
  | { readonly kind: typeof MODEL_ENDPOINT_AUTH.keep }

export type ModelEndpointAuthInfo =
  | { readonly kind: typeof MODEL_ENDPOINT_AUTH.bearer }
  | { readonly kind: typeof MODEL_ENDPOINT_AUTH.header; readonly name: string }

export interface ModelEndpointDraft {
  readonly baseUrl: string
  readonly format: ModelEndpointFormat
  readonly model: string
  readonly input: ModelEndpointInput
  readonly auth: ModelEndpointAuthInput
}

export const MODEL_ENDPOINT_RESULT = {
  works: "works",
  saved: "saved",
  keyRefused: "key_refused",
  wrongFormat: "wrong_format",
  unreachable: "unreachable",
  addressRefused: "address_refused",
  noToolCalls: "no_tool_calls",
  windowTooSmall: "window_too_small",
  windowUnknown: "window_unknown",
  modelMissing: "model_missing",
  noModel: "no_model",
  modelTaken: "model_taken"
} as const

export type ModelEndpointFailureReason =
  | typeof MODEL_ENDPOINT_RESULT.keyRefused
  | typeof MODEL_ENDPOINT_RESULT.wrongFormat
  | typeof MODEL_ENDPOINT_RESULT.unreachable

export type ModelEndpointRuntimeFailure =
  | typeof MODEL_ENDPOINT_RESULT.keyRefused
  | typeof MODEL_ENDPOINT_RESULT.unreachable

export const MODEL_ENDPOINT_HEALTH = { works: "works", failing: "failing" } as const

export type ModelEndpointHealth =
  | { readonly state: typeof MODEL_ENDPOINT_HEALTH.works }
  | {
      readonly state: typeof MODEL_ENDPOINT_HEALTH.failing
      readonly reason: ModelEndpointRuntimeFailure
      readonly since: string
      readonly message: string
    }

export interface ModelEndpoint extends JsonRecord {
  readonly kind: ModelEndpointKind
  readonly baseUrl: string
  readonly format: ModelEndpointFormat
  readonly model: string
  readonly input: ModelEndpointInput
  readonly auth: ModelEndpointAuthInfo
  readonly health: ModelEndpointHealth
}

export const MODEL_ENDPOINT_SLOT = { unset: "unset", saved: "saved" } as const

export type ModelEndpointSlot =
  | { readonly state: "unset" }
  | { readonly state: "saved"; readonly endpoint: ModelEndpoint }

export interface ModelEndpoints extends JsonRecord {
  readonly search: ModelEndpointSlot
  readonly decision: ModelEndpointSlot
  readonly chat: ReadonlyArray<ChatModelEndpoint>
}

export type ChatEndpointKind = "chat"

export const CHAT_ENDPOINT_SERVICE = {
  llamaCpp: "llama.cpp",
  openrouter: "openrouter",
  custom: "custom"
} as const

export type ChatEndpointService = (typeof CHAT_ENDPOINT_SERVICE)[keyof typeof CHAT_ENDPOINT_SERVICE]

export const CHAT_ENDPOINT_AUTH = { none: "none", bearer: "bearer", keep: "keep" } as const

export type ChatEndpointAuthInput =
  | { readonly kind: typeof CHAT_ENDPOINT_AUTH.none }
  | { readonly kind: typeof CHAT_ENDPOINT_AUTH.bearer; readonly apiKey: string }
  | { readonly kind: typeof CHAT_ENDPOINT_AUTH.keep }

export type ChatEndpointDraft =
  | {
      readonly service: typeof CHAT_ENDPOINT_SERVICE.llamaCpp
      readonly baseUrl: string
      readonly auth: ChatEndpointAuthInput
    }
  | {
      readonly service:
        | typeof CHAT_ENDPOINT_SERVICE.openrouter
        | typeof CHAT_ENDPOINT_SERVICE.custom
      readonly baseUrl: string
      readonly models: ReadonlyArray<string>
      readonly auth: ChatEndpointAuthInput
    }

export interface ChatEndpointModel {
  readonly id: string
  readonly contextWindow: number
  readonly imageInput: boolean
}

export type ChatEndpointSkip =
  | {
      readonly id: string
      readonly reason:
        | typeof MODEL_ENDPOINT_RESULT.noToolCalls
        | typeof MODEL_ENDPOINT_RESULT.windowUnknown
        | typeof MODEL_ENDPOINT_RESULT.modelTaken
        | typeof MODEL_ENDPOINT_RESULT.wrongFormat
    }
  | {
      readonly id: string
      readonly reason: typeof MODEL_ENDPOINT_RESULT.windowTooSmall
      readonly window: number
    }

export const CHAT_ENDPOINT_MIN_WINDOW = 32_768

export interface ChatModelEndpoint extends JsonRecord {
  readonly kind: ChatEndpointKind
  readonly id: string
  readonly service: ChatEndpointService
  readonly baseUrl: string
  readonly host: string
  readonly group: string
  readonly auth:
    | { readonly kind: typeof CHAT_ENDPOINT_AUTH.none }
    | { readonly kind: typeof CHAT_ENDPOINT_AUTH.bearer }
  readonly models: ReadonlyArray<ChatEndpointModel>
  readonly skipped: ReadonlyArray<ChatEndpointSkip>
  readonly health: ModelEndpointHealth
}

export type ChatEndpointCheckFailure =
  | ModelEndpointCheckFailure
  | {
      readonly result: typeof MODEL_ENDPOINT_RESULT.addressRefused
      readonly issue: BaseUrlIssue
      readonly message: string
    }
  | {
      readonly result: typeof MODEL_ENDPOINT_RESULT.noToolCalls
      readonly model: string
      readonly message: string
    }
  | {
      readonly result: typeof MODEL_ENDPOINT_RESULT.windowTooSmall
      readonly model: string
      readonly window: number
      readonly needed: number
      readonly message: string
    }
  | {
      readonly result: typeof MODEL_ENDPOINT_RESULT.windowUnknown
      readonly model: string
      readonly message: string
    }
  | {
      readonly result: typeof MODEL_ENDPOINT_RESULT.modelMissing
      readonly model: string
      readonly message: string
    }
  | { readonly result: typeof MODEL_ENDPOINT_RESULT.noModel; readonly message: string }
  | {
      readonly result: typeof MODEL_ENDPOINT_RESULT.modelTaken
      readonly model: string
      readonly message: string
    }

export type ChatEndpointCheck =
  | {
      readonly result: typeof MODEL_ENDPOINT_RESULT.works
      readonly host: string
      readonly group: string
      readonly models: ReadonlyArray<ChatEndpointModel>
      readonly skipped: ReadonlyArray<ChatEndpointSkip>
      readonly ms: number
    }
  | ChatEndpointCheckFailure

export type ChatEndpointSaveResult =
  | { readonly result: typeof MODEL_ENDPOINT_RESULT.saved; readonly endpoint: ChatModelEndpoint }
  | ChatEndpointCheckFailure

export type ModelEndpointCheckFailure = {
  readonly result: ModelEndpointFailureReason
  readonly message: string
}

export type ModelEndpointCheck =
  | {
      readonly result: typeof MODEL_ENDPOINT_RESULT.works
      readonly input: ModelEndpointInput
      readonly ms: number
    }
  | ModelEndpointCheckFailure

export type ModelEndpointSaveResult =
  | { readonly result: typeof MODEL_ENDPOINT_RESULT.saved; readonly endpoint: ModelEndpoint }
  | ModelEndpointCheckFailure

export const SEARCH_ENDPOINT_MODEL_ID = "search-endpoint"

export const DECISION_SOURCE = { local: "local", endpoint: "endpoint", off: "off" } as const

export type DecisionSource = (typeof DECISION_SOURCE)[keyof typeof DECISION_SOURCE]

export const DECISION_BACKEND = {
  off: "off",
  unavailable: "unavailable",
  ready: "ready",
  failing: "failing"
} as const

export const DECISION_BACKEND_GAP = {
  noLocalModel: "no_local_model",
  noEndpoint: "no_endpoint"
} as const

export type DecisionBackendGap = (typeof DECISION_BACKEND_GAP)[keyof typeof DECISION_BACKEND_GAP]

export type DecisionBackendState =
  | { readonly state: typeof DECISION_BACKEND.off }
  | { readonly state: typeof DECISION_BACKEND.unavailable; readonly reason: DecisionBackendGap }
  | {
      readonly state: typeof DECISION_BACKEND.ready
      readonly model: string
      readonly input: ModelEndpointInput
    }
  | {
      readonly state: typeof DECISION_BACKEND.failing
      readonly model: string
      readonly input: ModelEndpointInput
      readonly reason: ModelEndpointRuntimeFailure
      readonly since: string
    }

export type DecisionSiteId =
  | typeof MODEL_CALL_KIND.automationPrefilter
  | typeof MODEL_CALL_KIND.capture

export const DECISION_SITE_STATE = { decisionModel: "decision_model", helper: "helper" } as const

export type DecisionSiteState = (typeof DECISION_SITE_STATE)[keyof typeof DECISION_SITE_STATE]

export interface DecisionSiteStatus {
  readonly site: DecisionSiteId
  readonly needsImages: boolean
  readonly state: DecisionSiteState
}

export interface DecisionStatus extends JsonRecord {
  readonly source: DecisionSource
  readonly backend: DecisionBackendState
  readonly sites: ReadonlyArray<DecisionSiteStatus>
}
