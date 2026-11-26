import { Effect, Schema } from "effect"
import { IsoDateTimeStringSchema, NonNegativeIntSchema, withExtras } from "../common/schema.js"
import {
  MODEL_ENDPOINT_SLOT,
  type ChatEndpointCheck,
  type ChatEndpointDraft,
  type ChatEndpointSaveResult,
  type ChatModelEndpoint,
  type DecisionSiteStatus,
  type DecisionSource,
  type DecisionStatus,
  type ModelEndpoint,
  type ModelEndpointCheck,
  type ModelEndpointDraft,
  type ModelEndpoints,
  type ModelEndpointSaveResult,
  type ModelEndpointSlot
} from "./contracts.js"

const strict = { onExcessProperty: "error" } as const

const BaseUrlSchema = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2_048),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value)
      return url.protocol === "https:" || url.protocol === "http:"
        ? undefined
        : "must be an http or https address"
    } catch {
      return "must be an address"
    }
  })
)
const ModelNameSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const SecretSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(8_192))
/** An HTTP header token (RFC 9110), not one Arden sets itself. */
const HeaderNameSchema = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.makeFilter((name) => {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)) return "must be a header name"
    return ["content-type", "content-length", "host"].includes(name.toLowerCase())
      ? "must not be a header Arden sets"
      : undefined
  })
)
const MessageSchema = Schema.String.check(Schema.isMaxLength(4_096))

export const ModelEndpointKindSchema = Schema.Literals(["search", "decision"] as const)
/**
 * A saved model server's id, as the server assigns it: `:id` of
 * `/model-endpoints/chat/:id`. Never `check`, the segment of a new server's Check.
 */
export const ChatEndpointIdSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/u),
  Schema.makeFilter((id) => (id === "check" ? "must not be check" : undefined))
)
const FormatSchema = Schema.Literals([
  "openai-embeddings",
  "openai-decisions",
  "systemone",
  "openrouter-decisions"
] as const)
const InputSchema = Schema.Literals(["text", "text+image"] as const)
const FailureReasonSchema = Schema.Literals(["key_refused", "wrong_format", "unreachable"] as const)
const RuntimeFailureSchema = Schema.Literals(["key_refused", "unreachable"] as const)

const AuthInputWireSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("bearer"), api_key: SecretSchema }),
  Schema.Struct({ kind: Schema.Literal("header"), name: HeaderNameSchema, value: SecretSchema }),
  Schema.Struct({ kind: Schema.Literal("keep") })
])

/** The body of `PUT /model-endpoints/:kind` and `POST /model-endpoints/:kind/check`. */
export const ModelEndpointDraftRequestSchema = Schema.Struct({
  base_url: BaseUrlSchema,
  format: FormatSchema,
  model: ModelNameSchema,
  input: InputSchema,
  auth: AuthInputWireSchema
})

type DraftWire = typeof ModelEndpointDraftRequestSchema.Type

const draftFromWire = (wire: DraftWire): ModelEndpointDraft => ({
  baseUrl: wire.base_url,
  format: wire.format,
  model: wire.model,
  input: wire.input,
  auth: (() => {
    switch (wire.auth.kind) {
      case "bearer":
        return { kind: "bearer", apiKey: wire.auth.api_key }
      case "header":
        return { kind: "header", name: wire.auth.name, value: wire.auth.value }
      case "keep":
        return { kind: "keep" }
    }
  })()
})

export const decodeModelEndpointDraftEffect = (
  value: unknown
): Effect.Effect<ModelEndpointDraft, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(ModelEndpointDraftRequestSchema)(value, strict).pipe(
    Effect.map(draftFromWire)
  )

export const encodeModelEndpointDraftEffect = (
  draft: ModelEndpointDraft
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(ModelEndpointDraftRequestSchema)(
    {
      base_url: draft.baseUrl,
      format: draft.format,
      model: draft.model,
      input: draft.input,
      auth:
        draft.auth.kind === "bearer" ? { kind: "bearer", api_key: draft.auth.apiKey } : draft.auth
    },
    strict
  ).pipe(Effect.map(JSON.stringify))

export const DecisionSourceRequestSchema = Schema.Struct({
  source: Schema.Literals(["local", "endpoint", "off"] as const)
})

export const encodeChatEndpointPathEffect = (
  id: string
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(ChatEndpointIdSchema)(id).pipe(
    Effect.map((valid) => `/model-endpoints/chat/${valid}`)
  )

export const encodeDecisionSourceEffect = (
  source: DecisionSource
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(DecisionSourceRequestSchema)({ source }, strict).pipe(
    Effect.map(JSON.stringify)
  )

const HealthWireSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal("works") }),
  Schema.Struct({
    state: Schema.Literal("failing"),
    reason: RuntimeFailureSchema,
    since: IsoDateTimeStringSchema,
    message: MessageSchema
  })
])

const EndpointWireSchema = withExtras({
  kind: ModelEndpointKindSchema,
  base_url: BaseUrlSchema,
  format: FormatSchema,
  model: ModelNameSchema,
  input: InputSchema,
  auth: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("bearer") }),
    Schema.Struct({ kind: Schema.Literal("header"), name: HeaderNameSchema })
  ]),
  health: HealthWireSchema
})

type EndpointWire = typeof EndpointWireSchema.Type

const ChatServiceSchema = Schema.Literals(["llama.cpp", "openrouter", "custom"] as const)

const ChatAuthInputWireSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("bearer"), api_key: SecretSchema }),
  Schema.Struct({ kind: Schema.Literal("keep") })
])

/** At least one model, none twice: each becomes one id in the model list. */
const NamedModelsSchema = Schema.Array(ModelNameSchema).check(
  Schema.isMinLength(1),
  Schema.makeFilter((models) =>
    new Set(models).size === models.length ? undefined : "must not name a model twice"
  )
)

/** The body of every model server save and Check: `POST`/`PUT /model-endpoints/chat[/:id]`, `…/check`. */
export const ChatEndpointDraftRequestSchema = Schema.Union([
  Schema.Struct({
    service: Schema.Literal("llama.cpp"),
    base_url: BaseUrlSchema,
    auth: ChatAuthInputWireSchema
  }),
  Schema.Struct({
    service: Schema.Literals(["openrouter", "custom"] as const),
    base_url: BaseUrlSchema,
    models: NamedModelsSchema,
    auth: ChatAuthInputWireSchema
  })
])

type ChatDraftWire = typeof ChatEndpointDraftRequestSchema.Type

const chatAuthFromWire = (wire: ChatDraftWire["auth"]): ChatEndpointDraft["auth"] =>
  wire.kind === "bearer" ? { kind: "bearer", apiKey: wire.api_key } : wire

const chatDraftFromWire = (wire: ChatDraftWire): ChatEndpointDraft =>
  wire.service === "llama.cpp"
    ? { service: wire.service, baseUrl: wire.base_url, auth: chatAuthFromWire(wire.auth) }
    : {
        service: wire.service,
        baseUrl: wire.base_url,
        models: wire.models,
        auth: chatAuthFromWire(wire.auth)
      }

export const decodeChatEndpointDraftEffect = (
  value: unknown
): Effect.Effect<ChatEndpointDraft, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(ChatEndpointDraftRequestSchema)(value, strict).pipe(
    Effect.map(chatDraftFromWire)
  )

export const encodeChatEndpointDraftEffect = (
  draft: ChatEndpointDraft
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(ChatEndpointDraftRequestSchema)(
    {
      service: draft.service,
      base_url: draft.baseUrl,
      ...(draft.service === "llama.cpp" ? {} : { models: draft.models }),
      auth:
        draft.auth.kind === "bearer" ? { kind: "bearer", api_key: draft.auth.apiKey } : draft.auth
    },
    strict
  ).pipe(Effect.map(JSON.stringify))

const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0))

const ChatModelWireSchema = withExtras({
  id: ModelNameSchema,
  context_window: PositiveIntSchema,
  image_input: Schema.Boolean
})

const ChatSkipWireSchema = Schema.Union([
  Schema.Struct({
    id: ModelNameSchema,
    reason: Schema.Literals([
      "no_tool_calls",
      "window_unknown",
      "model_taken",
      "wrong_format"
    ] as const)
  }),
  Schema.Struct({
    id: ModelNameSchema,
    reason: Schema.Literal("window_too_small"),
    window: PositiveIntSchema
  })
])

const ChatEndpointWireSchema = withExtras({
  kind: Schema.Literal("chat"),
  id: ChatEndpointIdSchema,
  service: ChatServiceSchema,
  base_url: BaseUrlSchema,
  host: ModelNameSchema,
  group: ModelNameSchema,
  auth: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("none") }),
    Schema.Struct({ kind: Schema.Literal("bearer") })
  ]),
  models: Schema.Array(ChatModelWireSchema),
  skipped: Schema.Array(ChatSkipWireSchema),
  health: HealthWireSchema
})

type ChatEndpointWire = typeof ChatEndpointWireSchema.Type

const EndpointSlotWireSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal(MODEL_ENDPOINT_SLOT.unset) }),
  Schema.Struct({ state: Schema.Literal(MODEL_ENDPOINT_SLOT.saved), endpoint: EndpointWireSchema })
])

type EndpointSlotWire = typeof EndpointSlotWireSchema.Type

export const ModelEndpointsResponseSchema = withExtras({
  search: EndpointSlotWireSchema,
  decision: EndpointSlotWireSchema,
  chat: Schema.Array(ChatEndpointWireSchema)
})

const FailureWireSchema = Schema.Struct({ result: FailureReasonSchema, message: MessageSchema })

export const ModelEndpointCheckResponseSchema = Schema.Union([
  Schema.Struct({
    result: Schema.Literal("works"),
    input: InputSchema,
    ms: NonNegativeIntSchema
  }),
  FailureWireSchema
])

export const ModelEndpointSaveResponseSchema = Schema.Union([
  Schema.Struct({ result: Schema.Literal("saved"), endpoint: EndpointWireSchema }),
  FailureWireSchema
])

const ChatFailureWireSchema = Schema.Union([
  FailureWireSchema,
  Schema.Struct({
    result: Schema.Literal("address_refused"),
    issue: Schema.Literals(["invalid", "credentials", "fragment", "query", "insecure"] as const),
    message: MessageSchema
  }),
  Schema.Struct({
    result: Schema.Literals(["no_tool_calls", "window_unknown", "model_taken"] as const),
    model: ModelNameSchema,
    message: MessageSchema
  }),
  Schema.Struct({
    result: Schema.Literal("window_too_small"),
    model: ModelNameSchema,
    window: PositiveIntSchema,
    needed: PositiveIntSchema,
    message: MessageSchema
  }),
  Schema.Struct({
    result: Schema.Literal("model_missing"),
    model: ModelNameSchema,
    message: MessageSchema
  }),
  Schema.Struct({ result: Schema.Literal("no_model"), message: MessageSchema })
])

export const ChatEndpointCheckResponseSchema = Schema.Union([
  Schema.Struct({
    result: Schema.Literal("works"),
    host: ModelNameSchema,
    group: ModelNameSchema,
    models: Schema.Array(ChatModelWireSchema),
    skipped: Schema.Array(ChatSkipWireSchema),
    ms: NonNegativeIntSchema
  }),
  ChatFailureWireSchema
])

export const ChatEndpointSaveResponseSchema = Schema.Union([
  Schema.Struct({ result: Schema.Literal("saved"), endpoint: ChatEndpointWireSchema }),
  ChatFailureWireSchema
])

const SiteIdSchema = Schema.Literals(["automation_prefilter", "capture"] as const)

const SiteWireSchema = withExtras({
  site: SiteIdSchema,
  needs_images: Schema.Boolean,
  state: Schema.Literals(["decision_model", "helper"] as const)
})

type SiteWire = typeof SiteWireSchema.Type

export const DecisionStatusResponseSchema = withExtras({
  source: DecisionSourceRequestSchema.fields.source,
  backend: Schema.Union([
    Schema.Struct({ state: Schema.Literal("off") }),
    Schema.Struct({
      state: Schema.Literal("unavailable"),
      reason: Schema.Literals(["no_local_model", "no_endpoint"] as const)
    }),
    Schema.Struct({ state: Schema.Literal("ready"), model: ModelNameSchema, input: InputSchema }),
    Schema.Struct({
      state: Schema.Literal("failing"),
      model: ModelNameSchema,
      input: InputSchema,
      reason: RuntimeFailureSchema,
      since: IsoDateTimeStringSchema
    })
  ]),
  sites: Schema.Array(SiteWireSchema)
})

type DecisionStatusWire = typeof DecisionStatusResponseSchema.Type

const endpointFromWire = (wire: EndpointWire): ModelEndpoint => ({
  kind: wire.kind,
  baseUrl: wire.base_url,
  format: wire.format,
  model: wire.model,
  input: wire.input,
  auth: wire.auth.kind === "header" ? { kind: "header", name: wire.auth.name } : { kind: "bearer" },
  health:
    wire.health.state === "works"
      ? { state: "works" }
      : {
          state: "failing",
          reason: wire.health.reason,
          since: wire.health.since,
          message: wire.health.message
        }
})

export const endpointResponse = (endpoint: ModelEndpoint): EndpointWire => ({
  kind: endpoint.kind,
  base_url: endpoint.baseUrl,
  format: endpoint.format,
  model: endpoint.model,
  input: endpoint.input,
  auth: endpoint.auth,
  health: endpoint.health
})

type ChatModelWire = typeof ChatModelWireSchema.Type

const chatModelFromWire = (wire: ChatModelWire): ChatModelEndpoint["models"][number] => ({
  id: wire.id,
  contextWindow: wire.context_window,
  imageInput: wire.image_input
})

const chatModelResponse = (model: ChatModelEndpoint["models"][number]): ChatModelWire => ({
  id: model.id,
  context_window: model.contextWindow,
  image_input: model.imageInput
})

const chatEndpointFromWire = (wire: ChatEndpointWire): ChatModelEndpoint => ({
  kind: "chat",
  id: wire.id,
  service: wire.service,
  baseUrl: wire.base_url,
  host: wire.host,
  group: wire.group,
  auth: wire.auth,
  models: wire.models.map(chatModelFromWire),
  skipped: wire.skipped,
  health: wire.health
})

export const chatEndpointResponse = (endpoint: ChatModelEndpoint): ChatEndpointWire => ({
  kind: endpoint.kind,
  id: endpoint.id,
  service: endpoint.service,
  base_url: endpoint.baseUrl,
  host: endpoint.host,
  group: endpoint.group,
  auth: endpoint.auth,
  models: endpoint.models.map(chatModelResponse),
  skipped: endpoint.skipped,
  health: endpoint.health
})

const slotFromWire = (wire: EndpointSlotWire): ModelEndpointSlot =>
  wire.state === MODEL_ENDPOINT_SLOT.saved
    ? { state: wire.state, endpoint: endpointFromWire(wire.endpoint) }
    : wire

const slotResponse = (slot: ModelEndpointSlot): EndpointSlotWire =>
  slot.state === MODEL_ENDPOINT_SLOT.saved
    ? { state: slot.state, endpoint: endpointResponse(slot.endpoint) }
    : slot

export const mapModelEndpoints = (
  wire: typeof ModelEndpointsResponseSchema.Type
): ModelEndpoints => ({
  search: slotFromWire(wire.search),
  decision: slotFromWire(wire.decision),
  chat: wire.chat.map(chatEndpointFromWire)
})

export const modelEndpointsResponse = (
  endpoints: ModelEndpoints
): typeof ModelEndpointsResponseSchema.Type => ({
  search: slotResponse(endpoints.search),
  decision: slotResponse(endpoints.decision),
  chat: endpoints.chat.map(chatEndpointResponse)
})

export const mapChatEndpointCheck = (
  wire: typeof ChatEndpointCheckResponseSchema.Type
): ChatEndpointCheck =>
  wire.result === "works" ? { ...wire, models: wire.models.map(chatModelFromWire) } : wire

export const chatEndpointCheckResponse = (
  check: ChatEndpointCheck
): typeof ChatEndpointCheckResponseSchema.Type =>
  check.result === "works" ? { ...check, models: check.models.map(chatModelResponse) } : check

export const mapChatEndpointSave = (
  wire: typeof ChatEndpointSaveResponseSchema.Type
): ChatEndpointSaveResult =>
  wire.result === "saved"
    ? { result: "saved", endpoint: chatEndpointFromWire(wire.endpoint) }
    : wire

export const chatEndpointSaveResponse = (
  result: ChatEndpointSaveResult
): typeof ChatEndpointSaveResponseSchema.Type =>
  result.result === "saved"
    ? { result: "saved", endpoint: chatEndpointResponse(result.endpoint) }
    : result

/** The check union has the same field names on both sides. */
export const mapModelEndpointCheck = (
  wire: typeof ModelEndpointCheckResponseSchema.Type
): ModelEndpointCheck => wire

export const mapModelEndpointSave = (
  wire: typeof ModelEndpointSaveResponseSchema.Type
): ModelEndpointSaveResult =>
  wire.result === "saved" ? { result: "saved", endpoint: endpointFromWire(wire.endpoint) } : wire

export const modelEndpointSaveResponse = (
  result: ModelEndpointSaveResult
): typeof ModelEndpointSaveResponseSchema.Type =>
  result.result === "saved"
    ? { result: "saved", endpoint: endpointResponse(result.endpoint) }
    : result

const siteFromWire = (wire: SiteWire): DecisionSiteStatus => ({
  site: wire.site,
  needsImages: wire.needs_images,
  state: wire.state
})

const siteResponse = (site: DecisionSiteStatus): SiteWire => ({
  site: site.site,
  needs_images: site.needsImages,
  state: site.state
})

export const mapDecisionStatus = (wire: DecisionStatusWire): DecisionStatus => ({
  source: wire.source,
  backend: wire.backend,
  sites: wire.sites.map(siteFromWire)
})

export const decisionStatusResponse = (status: DecisionStatus): DecisionStatusWire => ({
  source: status.source,
  backend: status.backend,
  sites: status.sites.map(siteResponse)
})
