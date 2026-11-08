import { Effect, Schema, SchemaTransformation } from "effect"
import { withExtras } from "../common/schema.js"
import type {
  ModelAssignment,
  ModelCatalog,
  ModelOption,
  ModelProvider,
  ModelRole,
  ModelSettingsResponse,
  ModelSettingsPatch
} from "./contracts.js"

const strict = { onExcessProperty: "error" } as const
const ModelIdSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const LabelSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const ReasoningEffortSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(128))
const NullableModelIdSchema = Schema.NullOr(ModelIdSchema)
const NullableReasoningEffortSchema = Schema.NullOr(ReasoningEffortSchema)

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
  names: Schema.optionalKey(Schema.Record(ModelIdSchema, LabelSchema)),
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
    for (const modelId of Object.keys(catalog.names ?? {})) {
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
  model: NullableModelIdSchema,
  reasoning_effort: NullableReasoningEffortSchema
})

const ModelRolesResponseSchema = Schema.Struct({
  background: ModelRoleSelectionResponseSchema,
  helper: ModelRoleSelectionResponseSchema
})

/** The model-owned fields of `GET /config`; `config/schema.ts` composes them
 * with the tool-owned fields into the whole response. */
export const modelSettingsResponseFields = {
  chat_model: NullableModelIdSchema,
  reasoning_effort: NullableReasoningEffortSchema,
  reasoning_efforts: ReasoningEffortListSchema,
  model_reasoning_efforts: SelectedReasoningByModelSchema,
  model_roles: ModelRolesResponseSchema,
  at_defaults: Schema.optionalKey(Schema.Struct({ chat: Schema.Boolean, roles: Schema.Boolean }))
}

type ModelSettingsWireFields = Schema.Struct<typeof modelSettingsResponseFields>["Type"]

/** Cross-field rules of the model-owned `GET /config` fields. */
export const modelSettingsConsistency = Schema.makeFilter((settings: ModelSettingsWireFields) => {
  const roles = settings.model_roles
  const chatEffort =
    settings.chat_model === null
      ? null
      : (settings.model_reasoning_efforts[settings.chat_model] ?? null)
  if (settings.reasoning_effort !== chatEffort) {
    return { path: ["reasoning_effort"], issue: "does not match the selected chat model" }
  }
  if (
    settings.reasoning_effort !== null &&
    !settings.reasoning_efforts.includes(settings.reasoning_effort)
  ) {
    return { path: ["reasoning_effort"], issue: "is not supported by the selected chat model" }
  }

  for (const [role, selection] of Object.entries(roles)) {
    if (selection.model === null && selection.reasoning_effort !== null) {
      return { path: ["model_roles", role, "reasoning_effort"], issue: "requires a model" }
    }
  }
  return undefined
})

export const ModelSettingsResponseSchema = withExtras(modelSettingsResponseFields).check(
  modelSettingsConsistency
)

const ModelRolePatchSchema = Schema.Struct({
  modelId: Schema.optionalKey(NullableModelIdSchema),
  reasoningEffort: Schema.optionalKey(NullableReasoningEffortSchema)
}).check(
  Schema.makeFilter((patch) => {
    if (Object.keys(patch).length === 0) return "a role patch requires at least one field"
    return patch.modelId === null &&
      patch.reasoningEffort !== undefined &&
      patch.reasoningEffort !== null
      ? "a cleared role model cannot have a reasoning effort"
      : undefined
  })
)

const ModelRolesPatchSchema = Schema.Struct({
  background: Schema.optionalKey(ModelRolePatchSchema),
  helper: Schema.optionalKey(ModelRolePatchSchema)
}).check(
  Schema.makeFilter((roles) =>
    Object.keys(roles).length > 0 ? undefined : "roles must contain at least one role"
  )
)

const ModelReasoningPatchSchema = Schema.Struct({
  modelId: ModelIdSchema,
  effort: NullableReasoningEffortSchema
})

export const ModelSettingsPatchSchema = Schema.Struct({
  chatModelId: Schema.optionalKey(NullableModelIdSchema),
  modelReasoning: Schema.optionalKey(ModelReasoningPatchSchema),
  roles: Schema.optionalKey(ModelRolesPatchSchema)
}).check(
  Schema.makeFilter((patch) =>
    Object.keys(patch).length > 0 ? undefined : "a model settings patch requires at least one field"
  )
)

const ModelRolePatchRequestSchema = Schema.Struct({
  model: Schema.optionalKey(NullableModelIdSchema),
  reasoning_effort: Schema.optionalKey(NullableReasoningEffortSchema)
}).check(
  Schema.makeFilter((patch) => {
    if (Object.keys(patch).length === 0) return "a role patch requires at least one field"
    return patch.model === null &&
      patch.reasoning_effort !== undefined &&
      patch.reasoning_effort !== null
      ? "a cleared role model cannot have a reasoning effort"
      : undefined
  })
)

const ModelRolesPatchRequestSchema = Schema.Struct({
  background: Schema.optionalKey(ModelRolePatchRequestSchema),
  helper: Schema.optionalKey(ModelRolePatchRequestSchema)
}).check(
  Schema.makeFilter((roles) =>
    Object.keys(roles).length > 0 ? undefined : "model_roles must contain at least one role"
  )
)

/** The model-owned `PATCH /config` body. Exact: a key outside `fields` is refused. */
export const ModelSettingsPatchRequestSchema = Schema.Struct({
  chat_model: Schema.optionalKey(NullableModelIdSchema),
  reasoning_model: Schema.optionalKey(ModelIdSchema),
  reasoning_effort: Schema.optionalKey(NullableReasoningEffortSchema),
  model_roles: Schema.optionalKey(ModelRolesPatchRequestSchema)
})
  .check(
    Schema.makeFilter((patch) => {
      if (Object.keys(patch).length === 0) {
        return "a model settings patch requires at least one field"
      }
      return (patch.reasoning_model === undefined) === (patch.reasoning_effort === undefined)
        ? undefined
        : "reasoning_model and reasoning_effort must be provided together"
    })
  )
  .annotate({ parseOptions: strict })

type ModelProviderWire = Schema.Schema.Type<typeof ModelProviderResponseSchema>
type ModelCatalogWire = Schema.Schema.Type<typeof ModelCatalogResponseSchema>
type ModelSettingsPatchWire = Schema.Schema.Type<typeof ModelSettingsPatchSchema>
type ModelSettingsPatchRequestWire = Schema.Schema.Type<typeof ModelSettingsPatchRequestSchema>

const mapModel = (catalog: ModelCatalogWire, modelId: string): ModelOption => ({
  id: modelId,
  name: catalog.names?.[modelId] ?? modelId,
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
    settings.chat_model,
    settings.reasoning_effort,
    settings.model_reasoning_efforts
  ),
  roles: Object.fromEntries(
    Object.entries(settings.model_roles).map(([role, selection]) => [
      role,
      effectiveAssignment(
        selection.model,
        selection.reasoning_effort,
        settings.model_reasoning_efforts
      )
    ])
  ) as Record<ModelRole, ModelAssignment>,
  chatReasoningEfforts: settings.reasoning_efforts,
  reasoningByModel: settings.model_reasoning_efforts,
  atDefaults: settings.at_defaults ?? { chat: false, roles: false }
})

/** A cleared role model clears its effort too; an unset effort is left alone. */
const roleReasoningEffort = (
  value: Schema.Schema.Type<typeof ModelRolePatchSchema>
): { readonly reasoning_effort?: string | null } => {
  if (value.modelId === null) return { reasoning_effort: null }
  return value.reasoningEffort === undefined ? {} : { reasoning_effort: value.reasoningEffort }
}

const encodeSettingsPatch = (patch: ModelSettingsPatchWire): Record<string, unknown> => ({
  ...(patch.chatModelId === undefined ? {} : { chat_model: patch.chatModelId }),
  ...(patch.modelReasoning === undefined
    ? {}
    : {
        reasoning_model: patch.modelReasoning.modelId,
        reasoning_effort: patch.modelReasoning.effort
      }),
  ...(patch.roles === undefined
    ? {}
    : {
        model_roles: Object.fromEntries(
          Object.entries(patch.roles).map(([role, value]) => [
            role,
            {
              ...(value.modelId === undefined ? {} : { model: value.modelId }),
              ...roleReasoningEffort(value)
            }
          ])
        )
      })
})

/** Project a decoded model-owned `PATCH /config` body into the domain patch. */
export const toModelSettingsPatch = (patch: ModelSettingsPatchRequestWire): ModelSettingsPatch => ({
  ...(patch.chat_model === undefined ? {} : { chatModelId: patch.chat_model }),
  ...(patch.reasoning_model === undefined
    ? {}
    : {
        modelReasoning: {
          modelId: patch.reasoning_model,
          effort: patch.reasoning_effort ?? null
        }
      }),
  ...(patch.model_roles === undefined
    ? {}
    : {
        roles: Object.fromEntries(
          Object.entries(patch.model_roles).map(([role, value]) => [
            role,
            {
              ...(value.model === undefined ? {} : { modelId: value.model }),
              ...(value.reasoning_effort === undefined
                ? {}
                : { reasoningEffort: value.reasoning_effort })
            }
          ])
        )
      })
})

export const ModelResetRequestSchema = Schema.Struct({
  scope: Schema.Literals(["chat", "roles"])
})

export const encodeModelResetEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(ModelResetRequestSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

export const encodeModelSettingsPatchEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(ModelSettingsPatchSchema)(value, strict).pipe(
    Effect.map(encodeSettingsPatch),
    Effect.map(JSON.stringify)
  )

/** The ChatGPT transcription endpoint's own cap on one recording. */
export const TRANSCRIBE_MAX_BYTES = 25 * 1024 * 1024
/** What a renderer's MediaRecorder or a saved clip can hold. */
const AudioMediaTypeSchema = Schema.Literals([
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav"
])

/** One dictated clip. `data` is base64 on the wire and bytes once decoded. */
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
