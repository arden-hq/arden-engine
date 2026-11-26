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
  readonly health: ModelEndpointHealth
}

export const MODEL_ENDPOINT_SLOT = { unset: "unset", saved: "saved" } as const

export type ModelEndpointSlot =
  | { readonly state: "unset" }
  | { readonly state: "saved"; readonly endpoint: ModelEndpoint }

export interface ModelEndpoints extends JsonRecord {
  readonly search: ModelEndpointSlot
  readonly decision: ModelEndpointSlot
  /**
   * The saved model servers, in the order they were added; their models are
   * offered for chats beside ChatGPT's. A model id is on one server only.
   */
  readonly chat: ReadonlyArray<ChatModelEndpoint>
}

/**
 * The model servers' collection: `POST /model-endpoints/chat` adds one,
 * `PUT`/`DELETE /model-endpoints/chat/:id` replace or remove one, `POST
 * /model-endpoints/chat/check` checks a new one and `POST
 * /model-endpoints/chat/:id/check` an edit of a saved one. Not a
 * `ModelEndpointKind`: its draft, saved shape and Check differ.
 */
export type ChatEndpointKind = "chat"

/**
 * Which model server. `llama.cpp`: a `llama-server` the person runs; every
 * model it lists that Arden can use is offered. `openrouter`: the named
 * OpenRouter models. `custom`: the named models on any other Chat Completions
 * server, which reports nothing about them.
 */
export type ChatEndpointService = "llama.cpp" | "openrouter" | "custom"

/**
 * The key in a save or Check. `none`: the server takes no key. `keep`: the
 * key saved with the server being edited, for an edit at the same origin that
 * does not retype it; a new server has none to keep.
 */
export type ChatEndpointAuthInput =
  | { readonly kind: "none" }
  | { readonly kind: "bearer"; readonly apiKey: string }
  | { readonly kind: "keep" }

/** The model server form as the person filled it in. */
export type ChatEndpointDraft =
  | {
      readonly service: "llama.cpp"
      readonly baseUrl: string
      readonly auth: ChatEndpointAuthInput
    }
  | {
      readonly service: "openrouter" | "custom"
      readonly baseUrl: string
      /**
       * The models to offer, at least one and none twice. The Check proves
       * each is there; its one chat request goes to the first.
       */
      readonly models: ReadonlyArray<string>
      readonly auth: ChatEndpointAuthInput
    }

/** A model the server offers, as the model picker lists it. */
export interface ChatEndpointModel {
  readonly id: string
  /** Its context window in tokens. A `custom` server reports none: see `CHAT_ENDPOINT_MIN_WINDOW`. */
  readonly contextWindow: number
  readonly imageInput: boolean
}

/** A model the server lists that Arden does not offer, and why. Never dropped unsaid. */
export type ChatEndpointSkip =
  | {
      readonly id: string
      readonly reason: "no_tool_calls" | "window_unknown" | "model_taken" | "wrong_format"
    }
  | { readonly id: string; readonly reason: "window_too_small"; readonly window: number }

/**
 * The smallest window a chat model may have: the desktop app always offers
 * the full tool set, and its first request is about 14,100 tokens with tool
 * search (server README). A `custom` server reports no window, so its model is
 * taken to have exactly this one.
 */
export const CHAT_ENDPOINT_MIN_WINDOW = 32_768

export interface ChatModelEndpoint extends JsonRecord {
  readonly kind: ChatEndpointKind
  /** Assigned by the server when the server is added; names it in its routes. */
  readonly id: string
  readonly service: ChatEndpointService
  readonly baseUrl: string
  /** The address's host and port, as the row names it: `127.0.0.1:8080`. */
  readonly host: string
  /**
   * The model picker's group name: `llama.cpp`, `OpenRouter`, or a custom
   * server's host. When two saved servers would share a name, each carries
   * its host too: `llama.cpp · 127.0.0.1:8080`.
   */
  readonly group: string
  readonly auth: { readonly kind: "none" } | { readonly kind: "bearer" }
  /** What the server last reported, kept while it does not answer. */
  readonly models: ReadonlyArray<ChatEndpointModel>
  readonly skipped: ReadonlyArray<ChatEndpointSkip>
  readonly health: ModelEndpointHealth
}

/** Why a model server cannot be saved; each carries what its sentence names. */
export type ChatEndpointCheckFailure =
  | ModelEndpointCheckFailure
  | {
      /** The address is not one Arden sends requests to; `insecure`: a key over plain HTTP to another machine. */
      readonly result: "address_refused"
      readonly issue: "invalid" | "credentials" | "fragment" | "query" | "insecure"
      readonly message: string
    }
  | { readonly result: "no_tool_calls"; readonly model: string; readonly message: string }
  | {
      readonly result: "window_too_small"
      readonly model: string
      readonly window: number
      /** `CHAT_ENDPOINT_MIN_WINDOW`. */
      readonly needed: number
      readonly message: string
    }
  | { readonly result: "window_unknown"; readonly model: string; readonly message: string }
  | { readonly result: "model_missing"; readonly model: string; readonly message: string }
  | { readonly result: "no_model"; readonly message: string }
  | {
      /** The id is one another group of the model list uses: Codex's (`openai-codex/…`) or another saved server's. */
      readonly result: "model_taken"
      readonly model: string
      readonly message: string
    }

/**
 * Discovery plus one small chat request to the first offered model. `works`
 * lists what would be offered and what would not, and the group name the
 * server would have beside the ones saved.
 */
export type ChatEndpointCheck =
  | {
      readonly result: "works"
      readonly host: string
      readonly group: string
      readonly models: ReadonlyArray<ChatEndpointModel>
      readonly skipped: ReadonlyArray<ChatEndpointSkip>
      readonly ms: number
    }
  | ChatEndpointCheckFailure

/** A save runs the Check first; a failing server is not saved. */
export type ChatEndpointSaveResult =
  | { readonly result: "saved"; readonly endpoint: ChatModelEndpoint }
  | ChatEndpointCheckFailure

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
 * - `capture`: where a handed screenshot belongs.
 */
export type DecisionSiteId = "automation_prefilter" | "capture"

/**
 * Who decides at a place now:
 * - `decision_model`: the decision model, retried after failure, when its answer is sure enough.
 * - `helper`: the Helper, because the model cannot (off, unavailable, or the place
 *   needs images it does not read).
 */
export interface DecisionSiteStatus {
  readonly site: DecisionSiteId
  readonly needsImages: boolean
  readonly state: "decision_model" | "helper"
}

export interface DecisionStatus extends JsonRecord {
  readonly source: DecisionSource
  readonly backend: DecisionBackendState
  readonly sites: ReadonlyArray<DecisionSiteStatus>
}
