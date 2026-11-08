import { Effect, Schema } from "effect"
import { IsoDateTimeStringSchema, NonNegativeIntSchema, withExtras } from "../common/schema.js"
import type { EmbeddingIndexStatus, EmbeddingModelChoice } from "./contracts.js"

const ModelIdSchema = Schema.NonEmptyString.check(Schema.isMaxLength(512))
const ErrorTextSchema = Schema.NonEmptyString.check(Schema.isMaxLength(4_096))

const ModelInfoWireSchema = Schema.Struct({
  model_id: ModelIdSchema,
  dimensions: Schema.Int.check(Schema.isGreaterThan(0))
})

const StoredIndexWireSchema = Schema.Struct({
  model_id: ModelIdSchema,
  role: Schema.Literals(["serving", "building"] as const),
  bytes: NonNegativeIntSchema
})

const progress = {
  model_id: ModelIdSchema,
  indexed_pages: NonNegativeIntSchema,
  total_pages: NonNegativeIntSchema,
  models: Schema.Array(ModelInfoWireSchema),
  indexes: Schema.Array(StoredIndexWireSchema)
}

const pagesWithinTotal = Schema.makeFilter(
  (status: { readonly indexed_pages: number; readonly total_pages: number }) =>
    status.indexed_pages > status.total_pages
      ? { path: ["indexed_pages"], issue: "must not exceed total_pages" }
      : undefined
)

export const EmbeddingIndexStatusResponseSchema = Schema.Union([
  withExtras({
    state: Schema.Literal("idle"),
    kept_model_id: Schema.NullOr(ModelIdSchema),
    unavailable_model_id: Schema.NullOr(ModelIdSchema),
    models: Schema.Array(ModelInfoWireSchema),
    indexes: Schema.Array(StoredIndexWireSchema)
  }),
  withExtras({ state: Schema.Literal("done"), ...progress }).check(pagesWithinTotal),
  withExtras({
    state: Schema.Literals(["indexing", "paused"] as const),
    ...progress,
    previous_model_id: Schema.NullOr(ModelIdSchema),
    started_at: IsoDateTimeStringSchema,
    phase: Schema.optionalKey(Schema.Literals(["loading", "pages"] as const)),
    eta_seconds: Schema.NullOr(NonNegativeIntSchema)
  }).check(pagesWithinTotal),
  withExtras({
    state: Schema.Literal("failed"),
    ...progress,
    previous_model_id: Schema.NullOr(ModelIdSchema),
    error: ErrorTextSchema
  }).check(pagesWithinTotal)
])

type EmbeddingIndexStatusWire = Schema.Schema.Type<typeof EmbeddingIndexStatusResponseSchema>

const modelsFromWire = (models: EmbeddingIndexStatusWire["models"]) =>
  models.map((model) => ({ modelId: model.model_id, dimensions: model.dimensions }))

export const mapStatus = (status: EmbeddingIndexStatusWire): EmbeddingIndexStatus => {
  const models = modelsFromWire(status.models)
  const indexes = status.indexes.map((index) => ({
    modelId: index.model_id,
    role: index.role,
    bytes: index.bytes
  }))
  switch (status.state) {
    case "idle":
      return {
        state: "idle",
        keptModelId: status.kept_model_id,
        unavailableModelId: status.unavailable_model_id,
        models,
        indexes
      }
    case "done":
      return {
        state: "done",
        modelId: status.model_id,
        indexedPages: status.indexed_pages,
        totalPages: status.total_pages,
        models,
        indexes
      }
    case "indexing":
    case "paused":
      return {
        state: status.state,
        modelId: status.model_id,
        previousModelId: status.previous_model_id,
        indexedPages: status.indexed_pages,
        totalPages: status.total_pages,
        startedAt: status.started_at,
        phase: status.phase ?? "pages",
        etaSeconds: status.eta_seconds,
        models,
        indexes
      }
    case "failed":
      return {
        state: "failed",
        modelId: status.model_id,
        previousModelId: status.previous_model_id,
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
    case "idle":
      return {
        state: "idle",
        kept_model_id: status.keptModelId,
        unavailable_model_id: status.unavailableModelId,
        models,
        indexes
      }
    case "done":
      return {
        state: "done",
        model_id: status.modelId,
        indexed_pages: status.indexedPages,
        total_pages: status.totalPages,
        models,
        indexes
      }
    case "indexing":
    case "paused":
      return {
        state: status.state,
        model_id: status.modelId,
        previous_model_id: status.previousModelId,
        indexed_pages: status.indexedPages,
        total_pages: status.totalPages,
        started_at: status.startedAt,
        phase: status.phase,
        eta_seconds: status.etaSeconds,
        models,
        indexes
      }
    case "failed":
      return {
        state: "failed",
        model_id: status.modelId,
        previous_model_id: status.previousModelId,
        indexed_pages: status.indexedPages,
        total_pages: status.totalPages,
        error: status.error,
        models,
        indexes
      }
  }
}

/** A model id turns that model on; `model_id: null` turns search off and says
 *  whether the current index is kept. */
export const EmbeddingModelChoiceRequestSchema = Schema.Union([
  Schema.Struct({ model_id: ModelIdSchema }),
  Schema.Struct({ model_id: Schema.Null, keep_index: Schema.Boolean })
])

const strict = { onExcessProperty: "error" } as const

export const decodeEmbeddingModelChoiceRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(EmbeddingModelChoiceRequestSchema)(value, strict).pipe(
    Effect.map((choice): EmbeddingModelChoice =>
      "keep_index" in choice
        ? { kind: "off", keepIndex: choice.keep_index }
        : { kind: "model", modelId: choice.model_id }
    )
  )

export const encodeEmbeddingModelChoiceEffect = (value: EmbeddingModelChoice) =>
  Schema.decodeUnknownEffect(EmbeddingModelChoiceRequestSchema)(
    value.kind === "off"
      ? { model_id: null, keep_index: value.keepIndex }
      : { model_id: value.modelId },
    strict
  ).pipe(Effect.map(JSON.stringify))
