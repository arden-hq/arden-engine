import type { JsonRecord } from "../common/json.js"

/** `search`: the Wiki embedding model. `decision`: the decision (classifier) model. */
export type ModelEndpointKind = "search" | "decision"

/**
 * The wire format an endpoint speaks. Search: OpenAI-compatible `POST {base}/embeddings`.
 * Decision: OpenAI Decisions `POST {base}/v1/decisions`, or SystemOne `POST {base}/v1/systemone`.
 */
export type ModelEndpointFormat =
  | "openai-embeddings"
  | "openai-decisions"
  | "systemone"
  | "openrouter-decisions"

/** What a model reads. Declared by the person; a Check confirms it. */
export type ModelEndpointInput = "text" | "text+image"

/**
 * The credential in a save or Check. `keep` reuses the stored secret, so an edit to
 * other fields does not ask for the key again (only valid when one is stored).
 */
export type ModelEndpointAuthInput =
  | { readonly kind: "bearer"; readonly apiKey: string }
  | { readonly kind: "header"; readonly name: string; readonly value: string }
  | { readonly kind: "keep" }

/** The stored credential as the server reports it: never the secret. */
export type ModelEndpointAuthInfo =
  | { readonly kind: "bearer" }
  | { readonly kind: "header"; readonly name: string }

/** The form as the person filled it in. */
export interface ModelEndpointDraft {
  readonly baseUrl: string
  readonly format: ModelEndpointFormat
  readonly model: string
  readonly input: ModelEndpointInput
  readonly auth: ModelEndpointAuthInput
}

/** Why an endpoint does not work. */
export type ModelEndpointFailureReason = "key_refused" | "wrong_format" | "unreachable"

/**
 * A saved endpoint's runtime health. `failing` is recorded when calls start failing
 * (401/403 → `key_refused`, anything else → `unreachable`); the next successful call or
 * a new Check clears it. While failing, search falls back to word search and decisions
 * to today's path.
 */
export type ModelEndpointHealth =
  | { readonly state: "works" }
  | {
      readonly state: "failing"
      readonly reason: "key_refused" | "unreachable"
      readonly since: string
      readonly message: string
    }

export interface ModelEndpoint extends JsonRecord {
  readonly kind: ModelEndpointKind
  readonly baseUrl: string
  readonly format: ModelEndpointFormat
  readonly model: string
  /** Confirmed by the last Check. */
  readonly input: ModelEndpointInput
  readonly auth: ModelEndpointAuthInfo
  /** Search: the vector width the endpoint answers. Decision: null. */
  readonly dimensions: number | null
  readonly health: ModelEndpointHealth
}

export interface ModelEndpoints extends JsonRecord {
  readonly search: ModelEndpoint | null
  readonly decision: ModelEndpoint | null
}

export type ModelEndpointCheckFailure = {
  readonly result: ModelEndpointFailureReason
  readonly message: string
}

/**
 * One test request. `works` says what the model reads (for a decision endpoint that
 * declared images, `text` means the image probe failed) and, for search, the width.
 */
export type ModelEndpointCheck =
  | {
      readonly result: "works"
      readonly input: ModelEndpointInput
      readonly dimensions: number | null
      readonly ms: number
    }
  | ModelEndpointCheckFailure

/** A save runs the Check first; a failing endpoint is not saved. */
export type ModelEndpointSaveResult =
  | { readonly result: "saved"; readonly endpoint: ModelEndpoint }
  | ModelEndpointCheckFailure

/**
 * The embedding model id a saved search endpoint has in the embedding catalog
 * (`/embeddings/status` `models`, `PUT /embeddings/model`). Saving a search endpoint
 * does not switch search to it; choosing this id does (with the usual re-index).
 */
export const SEARCH_ENDPOINT_MODEL_ID = "search-endpoint"

/** Where decisions come from: the downloaded model, the saved endpoint, or nowhere. */
export type DecisionSource = "local" | "endpoint" | "off"

/**
 * The selected source right now. `unavailable`: nothing to ask (no local model
 * installed, no endpoint saved). `failing`: the endpoint stopped working.
 */
export type DecisionBackendState =
  | { readonly state: "off" }
  | { readonly state: "unavailable"; readonly reason: "no_local_model" | "no_endpoint" }
  | { readonly state: "ready"; readonly model: string; readonly input: ModelEndpointInput }
  | {
      readonly state: "failing"
      readonly model: string
      readonly input: ModelEndpointInput
      readonly reason: "key_refused" | "unreachable"
      readonly since: string
    }

/**
 * The places that ask a decision model ("Where it decides"), in display order.
 * The server's site registry (`models/decisions/sites.ts`) is the list of
 * callers; an id is added here when a caller asks.
 * - `automation_prefilter`: if an event should start an Automation ("Run only if").
 * - `space_review_gate`: if a Space review would find anything to do.
 * - `capture`: where a handed screenshot belongs.
 */
export type DecisionSiteId = "automation_prefilter" | "space_review_gate" | "capture"

/**
 * Who decides at a place now:
 * - `decision_model`: the decision model, retried after failure, when its answer is sure enough.
 * - `helper`: the Helper, because the model cannot (off, unavailable, or the place
 *   needs images it does not read) and the place lets the Helper answer.
 * - `not_used`: nobody; the place keeps its default.
 */
export interface DecisionSiteStatus {
  readonly site: DecisionSiteId
  readonly needsImages: boolean
  readonly state: "decision_model" | "helper" | "not_used"
}

export interface DecisionStatus extends JsonRecord {
  readonly source: DecisionSource
  readonly backend: DecisionBackendState
  readonly sites: ReadonlyArray<DecisionSiteStatus>
}
