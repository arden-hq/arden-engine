import { Effect, Schema } from "effect"
import { IsoDateTimeStringSchema, NonNegativeIntSchema, withExtras } from "../common/schema.js"
import type {
  DecisionSiteStatus,
  DecisionSource,
  DecisionStatus,
  ModelEndpoint,
  ModelEndpointCheck,
  ModelEndpointDraft,
  ModelEndpoints,
  ModelEndpointSaveResult
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

export const decodeModelEndpointDraftEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(ModelEndpointDraftRequestSchema)(value, strict).pipe(
    Effect.map(draftFromWire)
  )

export const encodeModelEndpointDraftEffect = (draft: ModelEndpointDraft) =>
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

export const encodeDecisionSourceEffect = (source: DecisionSource) =>
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
  dimensions: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  health: HealthWireSchema
})

type EndpointWire = typeof EndpointWireSchema.Type

export const ModelEndpointsResponseSchema = withExtras({
  search: Schema.NullOr(EndpointWireSchema),
  decision: Schema.NullOr(EndpointWireSchema)
})

const FailureWireSchema = Schema.Struct({ result: FailureReasonSchema, message: MessageSchema })

export const ModelEndpointCheckResponseSchema = Schema.Union([
  Schema.Struct({
    result: Schema.Literal("works"),
    input: InputSchema,
    dimensions: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
    ms: NonNegativeIntSchema
  }),
  FailureWireSchema
])

export const ModelEndpointSaveResponseSchema = Schema.Union([
  Schema.Struct({ result: Schema.Literal("saved"), endpoint: EndpointWireSchema }),
  FailureWireSchema
])

const SiteIdSchema = Schema.Literals([
  "automation_prefilter",
  "space_review_gate",
  "capture"
] as const)

const SiteWireSchema = withExtras({
  site: SiteIdSchema,
  needs_images: Schema.Boolean,
  state: Schema.Literals(["decision_model", "helper", "not_used"] as const)
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
  dimensions: wire.dimensions,
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
  dimensions: endpoint.dimensions,
  health: endpoint.health
})

export const mapModelEndpoints = (
  wire: typeof ModelEndpointsResponseSchema.Type
): ModelEndpoints => ({
  search: wire.search === null ? null : endpointFromWire(wire.search),
  decision: wire.decision === null ? null : endpointFromWire(wire.decision)
})

export const modelEndpointsResponse = (
  endpoints: ModelEndpoints
): typeof ModelEndpointsResponseSchema.Type => ({
  search: endpoints.search === null ? null : endpointResponse(endpoints.search),
  decision: endpoints.decision === null ? null : endpointResponse(endpoints.decision)
})

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
