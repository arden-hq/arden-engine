import { Effect, Schema } from "effect"
import { strict } from "../common/boundary.js"
import { IsoDateTimeStringSchema, NonNegativeIntSchema, withExtras } from "../common/schema.js"
import {
  EMBEDDING_ETA,
  EMBEDDING_INDEX_ROLE,
  EMBEDDING_MODEL_CHOICE,
  EMBEDDING_MODEL_REF,
  EMBEDDING_PHASE,
  EMBEDDING_STATE,
  type EmbeddingIndexStatus,
  type EmbeddingModelChoice,
  type EmbeddingModelRef
} from "./contracts.js"

const ModelIdSchema = Schema.NonEmptyString.check(Schema.isMaxLength(512))
const ErrorTextSchema = Schema.NonEmptyString.check(Schema.isMaxLength(4_096))

const ModelInfoWireSchema = Schema.Struct({
  model_id: ModelIdSchema,
  dimensions: Schema.Int.check(Schema.isGreaterThan(0))
})

const StoredIndexWireSchema = Schema.Struct({
  model_id: ModelIdSchema,
  role: Schema.Literals(Object.values(EMBEDDING_INDEX_ROLE)),
  bytes: NonNegativeIntSchema
})

const catalog = {
  models: Schema.Array(ModelInfoWireSchema),
  indexes: Schema.Array(StoredIndexWireSchema)
}

const progress = {
  model_id: ModelIdSchema,
  indexed_pages: NonNegativeIntSchema,
  total_pages: NonNegativeIntSchema,
  ...catalog
}

const ModelRefWireSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(EMBEDDING_MODEL_REF.none) }),
  Schema.Struct({ kind: Schema.Literal(EMBEDDING_MODEL_REF.model), model_id: ModelIdSchema })
])

const pagesWithinTotal = Schema.makeFilter(
  (status: { readonly indexed_pages: number; readonly total_pages: number }) =>
    status.indexed_pages > status.total_pages
      ? { path: ["indexed_pages"], issue: "must not exceed total_pages" }
      : undefined
)

export const EmbeddingIndexStatusResponseSchema = Schema.Union([
  withExtras({ state: Schema.Literal(EMBEDDING_STATE.off), kept: ModelRefWireSchema, ...catalog }),
  withExtras({
    state: Schema.Literal(EMBEDDING_STATE.unavailable),
    model_id: ModelIdSchema,
    ...catalog
  }),
  withExtras({ state: Schema.Literal(EMBEDDING_STATE.done), ...progress }).check(pagesWithinTotal),
  withExtras({
    state: Schema.Literal(EMBEDDING_STATE.indexing),
    ...progress,
    previous: ModelRefWireSchema,
    started_at: IsoDateTimeStringSchema,
    phase: Schema.Literals(Object.values(EMBEDDING_PHASE)),
    eta: Schema.Union([
      Schema.Struct({ kind: Schema.Literal(EMBEDDING_ETA.estimating) }),
      Schema.Struct({
        kind: Schema.Literal(EMBEDDING_ETA.estimated),
        seconds: NonNegativeIntSchema
      })
    ])
  }).check(pagesWithinTotal),
  withExtras({
    state: Schema.Literal(EMBEDDING_STATE.paused),
    ...progress,
    previous: ModelRefWireSchema,
    started_at: IsoDateTimeStringSchema
  }).check(pagesWithinTotal),
  withExtras({
    state: Schema.Literal(EMBEDDING_STATE.failed),
    ...progress,
    previous: ModelRefWireSchema,
    error: ErrorTextSchema
  }).check(pagesWithinTotal)
])

type EmbeddingIndexStatusWire = Schema.Schema.Type<typeof EmbeddingIndexStatusResponseSchema>
type ModelRefWire = Schema.Schema.Type<typeof ModelRefWireSchema>

const modelRefFromWire = (ref: ModelRefWire): EmbeddingModelRef =>
  ref.kind === EMBEDDING_MODEL_REF.model ? { kind: ref.kind, modelId: ref.model_id } : ref

const modelRefToWire = (ref: EmbeddingModelRef): ModelRefWire =>
  ref.kind === EMBEDDING_MODEL_REF.model ? { kind: ref.kind, model_id: ref.modelId } : ref

export const mapStatus = (status: EmbeddingIndexStatusWire): EmbeddingIndexStatus => {
  const models = status.models.map((model) => ({
    modelId: model.model_id,
    dimensions: model.dimensions
  }))
  const indexes = status.indexes.map((index) => ({
    modelId: index.model_id,
    role: index.role,
    bytes: index.bytes
  }))
  switch (status.state) {
    case EMBEDDING_STATE.off:
      return { state: status.state, kept: modelRefFromWire(status.kept), models, indexes }
    case EMBEDDING_STATE.unavailable:
      return { state: status.state, modelId: status.model_id, models, indexes }
    case EMBEDDING_STATE.done:
      return {
        state: status.state,
        modelId: status.model_id,
        indexedPages: status.indexed_pages,
        totalPages: status.total_pages,
        models,
        indexes
      }
    case EMBEDDING_STATE.indexing:
      return {
        state: status.state,
        modelId: status.model_id,
        previous: modelRefFromWire(status.previous),
        indexedPages: status.indexed_pages,
        totalPages: status.total_pages,
        startedAt: status.started_at,
        phase: status.phase,
        eta: status.eta,
        models,
        indexes
      }
    case EMBEDDING_STATE.paused:
      return {
        state: status.state,
        modelId: status.model_id,
        previous: modelRefFromWire(status.previous),
        indexedPages: status.indexed_pages,
        totalPages: status.total_pages,
        startedAt: status.started_at,
        models,
        indexes
      }
    case EMBEDDING_STATE.failed:
      return {
        state: status.state,
        modelId: status.model_id,
        previous: modelRefFromWire(status.previous),
        indexedPages: status.indexed_pages,
        totalPages: status.total_pages,
        error: status.error,
        models,
        indexes
      }
  }
}

export const embeddingStatusResponse = (status: EmbeddingIndexStatus): EmbeddingIndexStatusWire => {
  const models = status.models.map((model) => ({
    model_id: model.modelId,
    dimensions: model.dimensions
  }))
  const indexes = status.indexes.map((index) => ({
    model_id: index.modelId,
    role: index.role,
    bytes: index.bytes
  }))
  switch (status.state) {
    case EMBEDDING_STATE.off:
      return { state: status.state, kept: modelRefToWire(status.kept), models, indexes }
    case EMBEDDING_STATE.unavailable:
      return { state: status.state, model_id: status.modelId, models, indexes }
    case EMBEDDING_STATE.done:
      return {
        state: status.state,
        model_id: status.modelId,
        indexed_pages: status.indexedPages,
        total_pages: status.totalPages,
        models,
        indexes
      }
    case EMBEDDING_STATE.indexing:
      return {
        state: status.state,
        model_id: status.modelId,
        previous: modelRefToWire(status.previous),
        indexed_pages: status.indexedPages,
        total_pages: status.totalPages,
        started_at: status.startedAt,
        phase: status.phase,
        eta: status.eta,
        models,
        indexes
      }
    case EMBEDDING_STATE.paused:
      return {
        state: status.state,
        model_id: status.modelId,
        previous: modelRefToWire(status.previous),
        indexed_pages: status.indexedPages,
        total_pages: status.totalPages,
        started_at: status.startedAt,
        models,
        indexes
      }
    case EMBEDDING_STATE.failed:
      return {
        state: status.state,
        model_id: status.modelId,
        previous: modelRefToWire(status.previous),
        indexed_pages: status.indexedPages,
        total_pages: status.totalPages,
        error: status.error,
        models,
        indexes
      }
  }
}

export const EmbeddingModelChoiceRequestSchema = Schema.Union([
  Schema.Struct({ model_id: ModelIdSchema }),
  Schema.Struct({ model_id: Schema.Null, keep_index: Schema.Boolean })
])

export const decodeEmbeddingModelChoiceRequestEffect = (
  value: unknown
): Effect.Effect<EmbeddingModelChoice, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(EmbeddingModelChoiceRequestSchema)(value, strict).pipe(
    Effect.map((choice): EmbeddingModelChoice =>
      "keep_index" in choice
        ? { kind: EMBEDDING_MODEL_CHOICE.off, keepIndex: choice.keep_index }
        : { kind: EMBEDDING_MODEL_CHOICE.model, modelId: choice.model_id }
    )
  )

export const encodeEmbeddingModelChoiceEffect = (
  value: EmbeddingModelChoice
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(EmbeddingModelChoiceRequestSchema)(
    value.kind === EMBEDDING_MODEL_CHOICE.off
      ? { model_id: null, keep_index: value.keepIndex }
      : { model_id: value.modelId },
    strict
  ).pipe(Effect.map(JSON.stringify))
