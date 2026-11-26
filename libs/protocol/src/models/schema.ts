import { strict } from "../common/boundary.js"
import { Effect, Schema, SchemaTransformation } from "effect"
import { withExtras } from "../common/schema.js"
import {
  MODEL_RESET_SCOPE,
  MODEL_ROLE,
  MODEL_SETTINGS_CHANGE,
  MODEL_TARGET,
  REASONING_TARGET,
  type ModelAssignment,
  type ModelCatalog,
  type ModelOption,
  type ModelProvider,
  type ModelRole,
  type ModelSettingsChange,
  type ModelSettingsResponse,
  type ModelSettingsPatch,
  type ReasoningTarget
} from "./contracts.js"

const ModelIdSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const LabelSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const ReasoningEffortSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(128))

const ModelSlotSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(MODEL_TARGET.none) }),
  Schema.Struct({ kind: Schema.Literal(MODEL_TARGET.model), model_id: ModelIdSchema })
])
const ReasoningSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(REASONING_TARGET.default) }),
  Schema.Struct({ kind: Schema.Literal(REASONING_TARGET.effort), effort: ReasoningEffortSchema })
])
type ModelSlotWire = typeof ModelSlotSchema.Type
type ReasoningWire = typeof ReasoningSchema.Type

const ModelIdsSchema = Schema.UniqueArray(ModelIdSchema)
const NonEmptyModelIdsSchema = Schema.NonEmptyArray(ModelIdSchema).check(Schema.isUnique())
const ReasoningEffortListSchema = Schema.UniqueArray(ReasoningEffortSchema)
const ReasoningEffortsByModelSchema = Schema.Record(ModelIdSchema, ReasoningEffortListSchema)
const SelectedReasoningByModelSchema = Schema.Record(ModelIdSchema, ReasoningEffortSchema)

export const ModelProviderResponseSchema = withExtras({
  provider: ModelIdSchema,
  label: LabelSchema,
  models: NonEmptyModelIdsSchema
})

export const ModelCatalogResponseSchema = withExtras({
  models: ModelIdsSchema,
  names: Schema.Record(ModelIdSchema, LabelSchema),
  groups: Schema.Array(ModelProviderResponseSchema),
  reasoning_efforts: ReasoningEffortsByModelSchema
}).check(
  Schema.makeFilter((catalog) => {
    const modelIds = new Set(catalog.models)
    const grouped = new Set<string>()
    const providerIds = new Set<string>()

    for (const group of catalog.groups) {
      if (providerIds.has(group.provider)) {
        return { path: ["groups"], issue: `contains provider more than once: ${group.provider}` }
      }
      providerIds.add(group.provider)
      for (const modelId of group.models) {
        if (!modelIds.has(modelId)) {
          return { path: ["groups"], issue: `contains unknown model: ${modelId}` }
        }
        if (grouped.has(modelId)) {
          return { path: ["groups"], issue: `contains model more than once: ${modelId}` }
        }
        grouped.add(modelId)
      }
    }

    if (grouped.size !== modelIds.size) {
      return { path: ["groups"], issue: "does not cover every model exactly once" }
    }
    for (const modelId of Object.keys(catalog.names)) {
      if (!modelIds.has(modelId)) {
        return { path: ["names", modelId], issue: "does not name a catalog model" }
      }
    }
    for (const modelId of Object.keys(catalog.reasoning_efforts)) {
      if (!modelIds.has(modelId)) {
        return { path: ["reasoning_efforts", modelId], issue: "does not describe a catalog model" }
      }
    }
    return undefined
  })
)

const ModelRoleSelectionResponseSchema = withExtras({
  model: ModelSlotSchema,
  reasoning: ReasoningSchema
})

const ModelRolesResponseSchema = Schema.Struct({
  background: ModelRoleSelectionResponseSchema,
  helper: ModelRoleSelectionResponseSchema
})

export const modelSettingsResponseFields = {
  chat_model: ModelSlotSchema,
  reasoning: ReasoningSchema,
  reasoning_efforts: ReasoningEffortListSchema,
  model_reasoning_efforts: SelectedReasoningByModelSchema,
  model_roles: ModelRolesResponseSchema,
  at_defaults: Schema.Struct({ chat: Schema.Boolean, roles: Schema.Boolean })
}

type ModelSettingsWireFields = Schema.Struct<typeof modelSettingsResponseFields>["Type"]

export const modelIdOf = (slot: ModelSlotWire): string | null =>
  slot.kind === MODEL_TARGET.model ? slot.model_id : null

export const effortOf = (reasoning: ReasoningWire): string | null =>
  reasoning.kind === REASONING_TARGET.effort ? reasoning.effort : null

export const modelSlotOf = (modelId: string | null): ModelSlotWire =>
  modelId === null ? { kind: MODEL_TARGET.none } : { kind: MODEL_TARGET.model, model_id: modelId }

export const reasoningOf = (effort: string | null): ReasoningWire =>
  effort === null ? { kind: REASONING_TARGET.default } : { kind: REASONING_TARGET.effort, effort }

export const modelSettingsConsistency = Schema.makeFilter((settings: ModelSettingsWireFields) => {
  const roles = settings.model_roles
  const chatModel = modelIdOf(settings.chat_model)
  const chatEffort = effortOf(settings.reasoning)
  const savedEffort =
    chatModel === null ? null : (settings.model_reasoning_efforts[chatModel] ?? null)
  if (chatEffort !== savedEffort) {
    return { path: ["reasoning"], issue: "does not match the selected chat model" }
  }
  if (chatEffort !== null && !settings.reasoning_efforts.includes(chatEffort)) {
    return { path: ["reasoning"], issue: "is not supported by the selected chat model" }
  }

  for (const [role, selection] of Object.entries(roles)) {
    if (modelIdOf(selection.model) === null && effortOf(selection.reasoning) !== null) {
      return { path: ["model_roles", role, "reasoning"], issue: "requires a model" }
    }
  }
  return undefined
})

export const ModelSettingsResponseSchema = withExtras(modelSettingsResponseFields).check(
  modelSettingsConsistency
)

const RoleSchema = Schema.Literals(Object.values(MODEL_ROLE))

const ModelSettingsChangeRequestSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(MODEL_SETTINGS_CHANGE.chatModel), model: ModelSlotSchema }),
  Schema.Struct({
    kind: Schema.Literal(MODEL_SETTINGS_CHANGE.modelReasoning),
    model_id: ModelIdSchema,
    reasoning: ReasoningSchema
  }),
  Schema.Struct({
    kind: Schema.Literal(MODEL_SETTINGS_CHANGE.roleModel),
    role: RoleSchema,
    model: Schema.Union([
      Schema.Struct({ kind: Schema.Literal(MODEL_TARGET.chat) }),
      Schema.Struct({ kind: Schema.Literal(MODEL_TARGET.model), model_id: ModelIdSchema })
    ])
  }),
  Schema.Struct({
    kind: Schema.Literal(MODEL_SETTINGS_CHANGE.roleReasoning),
    role: RoleSchema,
    reasoning: ReasoningSchema
  })
])

export const ModelSettingsPatchRequestSchema = Schema.Struct({
  changes: Schema.NonEmptyArray(ModelSettingsChangeRequestSchema)
}).annotate({ parseOptions: strict })

type ModelProviderWire = Schema.Schema.Type<typeof ModelProviderResponseSchema>
type ModelCatalogWire = Schema.Schema.Type<typeof ModelCatalogResponseSchema>
type ModelSettingsPatchRequestWire = Schema.Schema.Type<typeof ModelSettingsPatchRequestSchema>
type ModelSettingsChangeWire = Schema.Schema.Type<typeof ModelSettingsChangeRequestSchema>

const mapModel = (catalog: ModelCatalogWire, modelId: string): ModelOption => ({
  id: modelId,
  name: catalog.names[modelId] ?? modelId,
  reasoningEfforts: catalog.reasoning_efforts[modelId] ?? []
})

const mapProvider = (catalog: ModelCatalogWire, group: ModelProviderWire): ModelProvider => {
  const { provider, label, models, id: _id, name: _name, ...extras } = group
  return {
    ...extras,
    id: provider,
    name: label,
    models: models.map((modelId) => mapModel(catalog, modelId))
  }
}

export const mapCatalog = (catalog: ModelCatalogWire): ModelCatalog => {
  const {
    models: _models,
    names: _names,
    groups,
    reasoning_efforts: _reasoningEfforts,
    providers: _providers,
    ...extras
  } = catalog
  return { ...extras, providers: groups.map((group) => mapProvider(catalog, group)) }
}

const effectiveAssignment = (
  modelId: string | null,
  override: string | null,
  modelDefaults: Readonly<Record<string, string>>
): ModelAssignment => ({
  modelId,
  reasoningEffort: override ?? (modelId === null ? null : (modelDefaults[modelId] ?? null))
})

export const mapSettings = (settings: ModelSettingsWireFields): ModelSettingsResponse => ({
  chat: effectiveAssignment(
    modelIdOf(settings.chat_model),
    effortOf(settings.reasoning),
    settings.model_reasoning_efforts
  ),
  roles: Object.fromEntries(
    Object.entries(settings.model_roles).map(([role, selection]) => [
      role,
      effectiveAssignment(
        modelIdOf(selection.model),
        effortOf(selection.reasoning),
        settings.model_reasoning_efforts
      )
    ])
  ) as Record<ModelRole, ModelAssignment>,
  chatReasoningEfforts: settings.reasoning_efforts,
  reasoningByModel: settings.model_reasoning_efforts,
  atDefaults: settings.at_defaults
})

const reasoningToWire = (reasoning: ReasoningTarget): ReasoningWire =>
  reasoning.kind === REASONING_TARGET.effort
    ? { kind: reasoning.kind, effort: reasoning.effort }
    : { kind: reasoning.kind }

const reasoningFromWire = (reasoning: ReasoningWire): ReasoningTarget =>
  reasoning.kind === REASONING_TARGET.effort
    ? { kind: reasoning.kind, effort: reasoning.effort }
    : { kind: reasoning.kind }

const changeToWire = (change: ModelSettingsChange): ModelSettingsChangeWire => {
  switch (change.kind) {
    case MODEL_SETTINGS_CHANGE.chatModel:
      return {
        kind: change.kind,
        model:
          change.model.kind === MODEL_TARGET.model
            ? { kind: change.model.kind, model_id: change.model.modelId }
            : { kind: change.model.kind }
      }
    case MODEL_SETTINGS_CHANGE.modelReasoning:
      return {
        kind: change.kind,
        model_id: change.modelId,
        reasoning: reasoningToWire(change.reasoning)
      }
    case MODEL_SETTINGS_CHANGE.roleModel:
      return {
        kind: change.kind,
        role: change.role,
        model:
          change.model.kind === MODEL_TARGET.model
            ? { kind: change.model.kind, model_id: change.model.modelId }
            : { kind: change.model.kind }
      }
    case MODEL_SETTINGS_CHANGE.roleReasoning:
      return { kind: change.kind, role: change.role, reasoning: reasoningToWire(change.reasoning) }
  }
}

const changeFromWire = (change: ModelSettingsChangeWire): ModelSettingsChange => {
  switch (change.kind) {
    case MODEL_SETTINGS_CHANGE.chatModel:
      return {
        kind: change.kind,
        model:
          change.model.kind === MODEL_TARGET.model
            ? { kind: change.model.kind, modelId: change.model.model_id }
            : { kind: change.model.kind }
      }
    case MODEL_SETTINGS_CHANGE.modelReasoning:
      return {
        kind: change.kind,
        modelId: change.model_id,
        reasoning: reasoningFromWire(change.reasoning)
      }
    case MODEL_SETTINGS_CHANGE.roleModel:
      return {
        kind: change.kind,
        role: change.role,
        model:
          change.model.kind === MODEL_TARGET.model
            ? { kind: change.model.kind, modelId: change.model.model_id }
            : { kind: change.model.kind }
      }
    case MODEL_SETTINGS_CHANGE.roleReasoning:
      return {
        kind: change.kind,
        role: change.role,
        reasoning: reasoningFromWire(change.reasoning)
      }
  }
}

export const toModelSettingsPatch = (patch: ModelSettingsPatchRequestWire): ModelSettingsPatch =>
  patch.changes.map(changeFromWire)

export const ModelResetRequestSchema = Schema.Struct({
  scope: Schema.Literals(Object.values(MODEL_RESET_SCOPE))
})

export const encodeModelResetEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(ModelResetRequestSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

export const encodeModelSettingsPatchEffect = (
  value: ModelSettingsPatch
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(ModelSettingsPatchRequestSchema)(
    { changes: value.map(changeToWire) },
    strict
  ).pipe(Effect.map(JSON.stringify))

// https://developers.openai.com/api/docs/guides/speech-to-text
export const TRANSCRIBE_MAX_BYTES = 25 * 1024 * 1024

const AudioMediaTypeSchema = Schema.Literals([
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav"
])

export const TranscribeInputSchema = Schema.Struct({
  media_type: AudioMediaTypeSchema,
  data: Schema.toEncoded(Schema.Uint8ArrayFromBase64)
    .check(Schema.isMinLength(1), Schema.isMaxLength(Math.ceil(TRANSCRIBE_MAX_BYTES / 3) * 4))
    .pipe(
      Schema.decodeTo(
        Schema.Uint8Array.check(Schema.isMinLength(1), Schema.isMaxLength(TRANSCRIBE_MAX_BYTES)),
        SchemaTransformation.uint8ArrayFromBase64String
      )
    )
})

export const TranscribeResponseSchema = Schema.Struct({ text: Schema.String })
