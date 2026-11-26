import { isWebProtocol } from "@arden-hq/std/url"
import { strict } from "../common/boundary.js"
import { Effect, Schema } from "effect"
import { IsoDateTimeStringSchema, NonNegativeIntSchema, withExtras } from "../common/schema.js"
import {
  CHAT_ENDPOINT_AUTH,
  CHAT_ENDPOINT_SERVICE,
  MODEL_ENDPOINT_AUTH,
  MODEL_ENDPOINT_FORMAT,
  MODEL_ENDPOINT_HEALTH,
  MODEL_ENDPOINT_INPUT,
  MODEL_ENDPOINT_KIND,
  MODEL_ENDPOINT_RESULT,
  MODEL_ENDPOINT_SLOT,
  type ChatEndpointCheck,
  type ChatEndpointDraft,
  type ChatEndpointSaveResult,
  type ChatModelEndpoint,
  type ModelEndpoint,
  type ModelEndpointCheck,
  type ModelEndpointDraft,
  type ModelEndpoints,
  type ModelEndpointSaveResult,
  type ModelEndpointSlot
} from "./contracts.js"
const BaseUrlSchema = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2_048),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value)
      return isWebProtocol(url.protocol) ? undefined : "must be an http or https address"
    } catch {
      return "must be an address"
    }
  })
)

export const ModelNameSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(512))

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

const RESERVED_CHAT_ENDPOINT_ID = "check"

const MessageSchema = Schema.String.check(Schema.isMaxLength(4_096))

export const ModelEndpointKindSchema = Schema.Literals(Object.values(MODEL_ENDPOINT_KIND))

export const ChatEndpointIdSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/u),
  Schema.makeFilter((id) => (id === RESERVED_CHAT_ENDPOINT_ID ? "must not be check" : undefined))
)

const FormatSchema = Schema.Literals(Object.values(MODEL_ENDPOINT_FORMAT))

export const InputSchema = Schema.Literals(Object.values(MODEL_ENDPOINT_INPUT))

const FailureReasonSchema = Schema.Literals([
  MODEL_ENDPOINT_RESULT.keyRefused,
  MODEL_ENDPOINT_RESULT.wrongFormat,
  MODEL_ENDPOINT_RESULT.unreachable
])

export const RuntimeFailureSchema = Schema.Literals([
  MODEL_ENDPOINT_RESULT.keyRefused,
  MODEL_ENDPOINT_RESULT.unreachable
])

const AuthInputWireSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(MODEL_ENDPOINT_AUTH.bearer), api_key: SecretSchema }),
  Schema.Struct({
    kind: Schema.Literal(MODEL_ENDPOINT_AUTH.header),
    name: HeaderNameSchema,
    value: SecretSchema
  }),
  Schema.Struct({ kind: Schema.Literal(MODEL_ENDPOINT_AUTH.keep) })
])

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
      case MODEL_ENDPOINT_AUTH.bearer:
        return { kind: MODEL_ENDPOINT_AUTH.bearer, apiKey: wire.auth.api_key }
      case MODEL_ENDPOINT_AUTH.header:
        return { kind: MODEL_ENDPOINT_AUTH.header, name: wire.auth.name, value: wire.auth.value }
      case MODEL_ENDPOINT_AUTH.keep:
        return { kind: MODEL_ENDPOINT_AUTH.keep }
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
        draft.auth.kind === MODEL_ENDPOINT_AUTH.bearer
          ? { kind: MODEL_ENDPOINT_AUTH.bearer, api_key: draft.auth.apiKey }
          : draft.auth
    },
    strict
  ).pipe(Effect.map(JSON.stringify))

export const encodeChatEndpointPathEffect = (
  id: string
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(ChatEndpointIdSchema)(id).pipe(
    Effect.map((valid) => `/model-endpoints/chat/${valid}`)
  )

const HealthWireSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal(MODEL_ENDPOINT_HEALTH.works) }),
  Schema.Struct({
    state: Schema.Literal(MODEL_ENDPOINT_HEALTH.failing),
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
    Schema.Struct({ kind: Schema.Literal(MODEL_ENDPOINT_AUTH.bearer) }),
    Schema.Struct({ kind: Schema.Literal(MODEL_ENDPOINT_AUTH.header), name: HeaderNameSchema })
  ]),
  health: HealthWireSchema
})

type EndpointWire = typeof EndpointWireSchema.Type

const ChatServiceSchema = Schema.Literals(Object.values(CHAT_ENDPOINT_SERVICE))

const ChatAuthInputWireSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(CHAT_ENDPOINT_AUTH.none) }),
  Schema.Struct({ kind: Schema.Literal(CHAT_ENDPOINT_AUTH.bearer), api_key: SecretSchema }),
  Schema.Struct({ kind: Schema.Literal(CHAT_ENDPOINT_AUTH.keep) })
])

const NamedModelsSchema = Schema.Array(ModelNameSchema).check(
  Schema.isMinLength(1),
  Schema.makeFilter((models) =>
    new Set(models).size === models.length ? undefined : "must not name a model twice"
  )
)

export const ChatEndpointDraftRequestSchema = Schema.Union([
  Schema.Struct({
    service: Schema.Literal(CHAT_ENDPOINT_SERVICE.llamaCpp),
    base_url: BaseUrlSchema,
    auth: ChatAuthInputWireSchema
  }),
  Schema.Struct({
    service: Schema.Literals([CHAT_ENDPOINT_SERVICE.openrouter, CHAT_ENDPOINT_SERVICE.custom]),
    base_url: BaseUrlSchema,
    models: NamedModelsSchema,
    auth: ChatAuthInputWireSchema
  })
])

type ChatDraftWire = typeof ChatEndpointDraftRequestSchema.Type

const chatAuthFromWire = (wire: ChatDraftWire["auth"]): ChatEndpointDraft["auth"] =>
  wire.kind === CHAT_ENDPOINT_AUTH.bearer
    ? { kind: CHAT_ENDPOINT_AUTH.bearer, apiKey: wire.api_key }
    : wire

const chatDraftFromWire = (wire: ChatDraftWire): ChatEndpointDraft =>
  wire.service === CHAT_ENDPOINT_SERVICE.llamaCpp
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
      ...(draft.service === CHAT_ENDPOINT_SERVICE.llamaCpp ? {} : { models: draft.models }),
      auth:
        draft.auth.kind === CHAT_ENDPOINT_AUTH.bearer
          ? { kind: CHAT_ENDPOINT_AUTH.bearer, api_key: draft.auth.apiKey }
          : draft.auth
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
      MODEL_ENDPOINT_RESULT.noToolCalls,
      MODEL_ENDPOINT_RESULT.windowUnknown,
      MODEL_ENDPOINT_RESULT.modelTaken,
      MODEL_ENDPOINT_RESULT.wrongFormat
    ])
  }),
  Schema.Struct({
    id: ModelNameSchema,
    reason: Schema.Literal(MODEL_ENDPOINT_RESULT.windowTooSmall),
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
    Schema.Struct({ kind: Schema.Literal(CHAT_ENDPOINT_AUTH.none) }),
    Schema.Struct({ kind: Schema.Literal(CHAT_ENDPOINT_AUTH.bearer) })
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
    result: Schema.Literal(MODEL_ENDPOINT_RESULT.works),
    input: InputSchema,
    ms: NonNegativeIntSchema
  }),
  FailureWireSchema
])

export const ModelEndpointSaveResponseSchema = Schema.Union([
  Schema.Struct({
    result: Schema.Literal(MODEL_ENDPOINT_RESULT.saved),
    endpoint: EndpointWireSchema
  }),
  FailureWireSchema
])

const ChatFailureWireSchema = Schema.Union([
  FailureWireSchema,
  Schema.Struct({
    result: Schema.Literal(MODEL_ENDPOINT_RESULT.addressRefused),
    issue: Schema.Literals(["invalid", "credentials", "fragment", "query", "insecure"] as const),
    message: MessageSchema
  }),
  Schema.Struct({
    result: Schema.Literals([
      MODEL_ENDPOINT_RESULT.noToolCalls,
      MODEL_ENDPOINT_RESULT.windowUnknown,
      MODEL_ENDPOINT_RESULT.modelTaken
    ]),
    model: ModelNameSchema,
    message: MessageSchema
  }),
  Schema.Struct({
    result: Schema.Literal(MODEL_ENDPOINT_RESULT.windowTooSmall),
    model: ModelNameSchema,
    window: PositiveIntSchema,
    needed: PositiveIntSchema,
    message: MessageSchema
  }),
  Schema.Struct({
    result: Schema.Literal(MODEL_ENDPOINT_RESULT.modelMissing),
    model: ModelNameSchema,
    message: MessageSchema
  }),
  Schema.Struct({ result: Schema.Literal(MODEL_ENDPOINT_RESULT.noModel), message: MessageSchema })
])

export const ChatEndpointCheckResponseSchema = Schema.Union([
  Schema.Struct({
    result: Schema.Literal(MODEL_ENDPOINT_RESULT.works),
    host: ModelNameSchema,
    group: ModelNameSchema,
    models: Schema.Array(ChatModelWireSchema),
    skipped: Schema.Array(ChatSkipWireSchema),
    ms: NonNegativeIntSchema
  }),
  ChatFailureWireSchema
])

export const ChatEndpointSaveResponseSchema = Schema.Union([
  Schema.Struct({
    result: Schema.Literal(MODEL_ENDPOINT_RESULT.saved),
    endpoint: ChatEndpointWireSchema
  }),
  ChatFailureWireSchema
])

const endpointFromWire = (wire: EndpointWire): ModelEndpoint => ({
  kind: wire.kind,
  baseUrl: wire.base_url,
  format: wire.format,
  model: wire.model,
  input: wire.input,
  auth:
    wire.auth.kind === MODEL_ENDPOINT_AUTH.header
      ? { kind: MODEL_ENDPOINT_AUTH.header, name: wire.auth.name }
      : { kind: MODEL_ENDPOINT_AUTH.bearer },
  health:
    wire.health.state === MODEL_ENDPOINT_HEALTH.works
      ? { state: MODEL_ENDPOINT_HEALTH.works }
      : {
          state: MODEL_ENDPOINT_HEALTH.failing,
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
  wire.result === MODEL_ENDPOINT_RESULT.works
    ? { ...wire, models: wire.models.map(chatModelFromWire) }
    : wire

export const chatEndpointCheckResponse = (
  check: ChatEndpointCheck
): typeof ChatEndpointCheckResponseSchema.Type =>
  check.result === MODEL_ENDPOINT_RESULT.works
    ? { ...check, models: check.models.map(chatModelResponse) }
    : check

export const mapChatEndpointSave = (
  wire: typeof ChatEndpointSaveResponseSchema.Type
): ChatEndpointSaveResult =>
  wire.result === MODEL_ENDPOINT_RESULT.saved
    ? { result: MODEL_ENDPOINT_RESULT.saved, endpoint: chatEndpointFromWire(wire.endpoint) }
    : wire

export const chatEndpointSaveResponse = (
  result: ChatEndpointSaveResult
): typeof ChatEndpointSaveResponseSchema.Type =>
  result.result === MODEL_ENDPOINT_RESULT.saved
    ? { result: MODEL_ENDPOINT_RESULT.saved, endpoint: chatEndpointResponse(result.endpoint) }
    : result

export const mapModelEndpointCheck = (
  wire: typeof ModelEndpointCheckResponseSchema.Type
): ModelEndpointCheck => wire

export const mapModelEndpointSave = (
  wire: typeof ModelEndpointSaveResponseSchema.Type
): ModelEndpointSaveResult =>
  wire.result === MODEL_ENDPOINT_RESULT.saved
    ? { result: MODEL_ENDPOINT_RESULT.saved, endpoint: endpointFromWire(wire.endpoint) }
    : wire

export const modelEndpointSaveResponse = (
  result: ModelEndpointSaveResult
): typeof ModelEndpointSaveResponseSchema.Type =>
  result.result === MODEL_ENDPOINT_RESULT.saved
    ? { result: MODEL_ENDPOINT_RESULT.saved, endpoint: endpointResponse(result.endpoint) }
    : result
