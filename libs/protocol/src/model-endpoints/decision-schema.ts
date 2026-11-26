import { Effect, Schema } from "effect"
import { strict } from "../common/boundary.js"
import { IsoDateTimeStringSchema, withExtras } from "../common/schema.js"
import {
  DECISION_BACKEND,
  DECISION_BACKEND_GAP,
  DECISION_SITE_STATE,
  DECISION_SOURCE,
  type DecisionSiteStatus,
  type DecisionSource,
  type DecisionStatus
} from "./contracts.js"
import { MODEL_CALL_KIND } from "../runs/usage.js"
import { InputSchema, ModelNameSchema, RuntimeFailureSchema } from "./schema.js"

export const DecisionSourceRequestSchema = Schema.Struct({
  source: Schema.Literals(Object.values(DECISION_SOURCE))
})

export const encodeDecisionSourceEffect = (
  source: DecisionSource
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(DecisionSourceRequestSchema)({ source }, strict).pipe(
    Effect.map(JSON.stringify)
  )

const SiteIdSchema = Schema.Literals([MODEL_CALL_KIND.automationPrefilter, MODEL_CALL_KIND.capture])

const SiteWireSchema = withExtras({
  site: SiteIdSchema,
  needs_images: Schema.Boolean,
  state: Schema.Literals(Object.values(DECISION_SITE_STATE))
})

type SiteWire = typeof SiteWireSchema.Type

export const DecisionStatusResponseSchema = withExtras({
  source: DecisionSourceRequestSchema.fields.source,
  backend: Schema.Union([
    Schema.Struct({ state: Schema.Literal(DECISION_BACKEND.off) }),
    Schema.Struct({
      state: Schema.Literal(DECISION_BACKEND.unavailable),
      reason: Schema.Literals(Object.values(DECISION_BACKEND_GAP))
    }),
    Schema.Struct({
      state: Schema.Literal(DECISION_BACKEND.ready),
      model: ModelNameSchema,
      input: InputSchema
    }),
    Schema.Struct({
      state: Schema.Literal(DECISION_BACKEND.failing),
      model: ModelNameSchema,
      input: InputSchema,
      reason: RuntimeFailureSchema,
      since: IsoDateTimeStringSchema
    })
  ]),
  sites: Schema.Array(SiteWireSchema)
})

type DecisionStatusWire = typeof DecisionStatusResponseSchema.Type

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
