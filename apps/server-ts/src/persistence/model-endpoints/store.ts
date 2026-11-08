import { Context, type Effect, Schema } from "effect"

import { storeErrorFields } from "../errors.js"

const Text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))

const RuntimeFailureSchema = Schema.Literals(["key_refused", "unreachable"] as const)

const EndpointHealthSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal("works") }),
  Schema.Struct({
    state: Schema.Literal("failing"),
    reason: RuntimeFailureSchema,
    since: Schema.String,
    message: Schema.String
  })
])

export type EndpointHealth = typeof EndpointHealthSchema.Type

const StoredEndpointSchema = Schema.Struct({
  baseUrl: Text(2_048),
  format: Schema.Literals([
    "openai-embeddings",
    "openai-decisions",
    "systemone",
    "openrouter-decisions"
  ] as const),
  model: Text(512),
  input: Schema.Literals(["text", "text+image"] as const),
  auth: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("bearer") }),
    Schema.Struct({ kind: Schema.Literal("header"), name: Text(128) })
  ]),
  dimensions: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  health: EndpointHealthSchema
})

export type StoredEndpoint = typeof StoredEndpointSchema.Type

const DecisionSourceSchema = Schema.Literals(["local", "endpoint", "off"] as const)

export const ModelEndpointSettingsSchema = Schema.Struct({
  search: Schema.NullOr(StoredEndpointSchema),
  decision: Schema.NullOr(StoredEndpointSchema),
  decisionSource: DecisionSourceSchema
})

export type ModelEndpointSettings = typeof ModelEndpointSettingsSchema.Type

export const ModelEndpointSettingsPatchSchema = Schema.Struct({
  search: Schema.optionalKey(Schema.NullOr(StoredEndpointSchema)),
  decision: Schema.optionalKey(Schema.NullOr(StoredEndpointSchema)),
  decisionSource: Schema.optionalKey(DecisionSourceSchema)
})

export type ModelEndpointSettingsPatch = typeof ModelEndpointSettingsPatchSchema.Type

export const DEFAULT_MODEL_ENDPOINT_SETTINGS: ModelEndpointSettings = {
  search: null,
  decision: null,
  decisionSource: "local"
}

export class ModelEndpointStoreError extends Schema.TaggedError<ModelEndpointStoreError>()(
  "ModelEndpointStoreError",
  {
    ...storeErrorFields({
      operations: ["settings", "update_settings"],
      reasons: ["invalid", "storage"]
    })
  }
) {}

export class ModelEndpointStore extends Context.Service<
  ModelEndpointStore,
  {
    readonly settings: () => Effect.Effect<ModelEndpointSettings, ModelEndpointStoreError>
    readonly updateSettings: (
      patch:
        | ModelEndpointSettingsPatch
        | ((current: ModelEndpointSettings) => ModelEndpointSettingsPatch)
    ) => Effect.Effect<ModelEndpointSettings, ModelEndpointStoreError>
  }
>()("@arden-hq/server/persistence/model-endpoints/ModelEndpointStore") {}
