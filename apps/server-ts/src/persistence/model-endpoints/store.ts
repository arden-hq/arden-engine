import type { ChatCompletionsCompat } from "@arden-hq/loop/providers/chat-completions"
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

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

/**
 * How a model's requests are shaped, as discovery reported it. Keyed by every
 * `ChatCompletionsCompat` field, so a field the adapter gains fails to compile
 * here instead of being left out of what is saved.
 */
const COMPAT_FIELDS = {
  maxTokensField: Schema.Literals(["max_completion_tokens", "max_tokens"] as const),
  systemRole: Schema.Literals(["system", "developer"] as const),
  reasoningEffort: Schema.Literals(["reasoning_effort", "openrouter", "none"] as const),
  usageInStream: Schema.Boolean,
  structuredOutput: Schema.Literals(["json_schema", "none"] as const),
  imageInput: Schema.Boolean,
  parallelToolCalls: Schema.Boolean,
  cacheControl: Schema.Literals(["anthropic", "none"] as const),
  toolChoiceNone: Schema.Literals(["enforced", "unenforced"] as const)
} satisfies Record<keyof ChatCompletionsCompat, Schema.Top>

const StoredCompatSchema = Schema.Struct({
  maxTokensField: Schema.optionalKey(COMPAT_FIELDS.maxTokensField),
  systemRole: Schema.optionalKey(COMPAT_FIELDS.systemRole),
  reasoningEffort: Schema.optionalKey(COMPAT_FIELDS.reasoningEffort),
  usageInStream: Schema.optionalKey(COMPAT_FIELDS.usageInStream),
  structuredOutput: Schema.optionalKey(COMPAT_FIELDS.structuredOutput),
  imageInput: Schema.optionalKey(COMPAT_FIELDS.imageInput),
  parallelToolCalls: Schema.optionalKey(COMPAT_FIELDS.parallelToolCalls),
  cacheControl: Schema.optionalKey(COMPAT_FIELDS.cacheControl),
  toolChoiceNone: Schema.optionalKey(COMPAT_FIELDS.toolChoiceNone)
} satisfies Record<keyof ChatCompletionsCompat, Schema.Top>)

/** One model the saved server offers, as its last successful discovery reported it. */
const StoredChatModelSchema = Schema.Struct({
  id: Text(512),
  /** The window Arden uses: the server's own, or `CHAT_ENDPOINT_MIN_WINDOW` for a custom server. */
  window: PositiveInt,
  outputCap: Schema.NullOr(PositiveInt),
  reasoningEfforts: Schema.Array(Text(128)),
  compat: StoredCompatSchema
})

export type StoredChatModel = typeof StoredChatModelSchema.Type

const ChatSkipSchema = Schema.Union([
  Schema.Struct({
    id: Text(512),
    reason: Schema.Literals([
      "no_tool_calls",
      "window_unknown",
      "model_taken",
      "wrong_format"
    ] as const)
  }),
  Schema.Struct({ id: Text(512), reason: Schema.Literal("window_too_small"), window: PositiveInt })
])

/**
 * The saved model server. Its models are kept while it does not answer, so
 * chats and defaults that name them keep them; the key is in the vault.
 */
const StoredChatEndpointSchema = Schema.Struct({
  service: Schema.Literals(["llama.cpp", "openrouter", "custom"] as const),
  baseUrl: Text(2_048),
  auth: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("none") }),
    Schema.Struct({ kind: Schema.Literal("bearer") })
  ]),
  models: Schema.Array(StoredChatModelSchema).check(Schema.isMinLength(1)),
  skipped: Schema.Array(ChatSkipSchema),
  health: EndpointHealthSchema
})

export type StoredChatEndpoint = typeof StoredChatEndpointSchema.Type

const DecisionSourceSchema = Schema.Literals(["local", "endpoint", "off"] as const)

export const ModelEndpointSettingsSchema = Schema.Struct({
  search: Schema.NullOr(StoredEndpointSchema),
  decision: Schema.NullOr(StoredEndpointSchema),
  chat: Schema.NullOr(StoredChatEndpointSchema),
  decisionSource: DecisionSourceSchema
})

export type ModelEndpointSettings = typeof ModelEndpointSettingsSchema.Type

export const ModelEndpointSettingsPatchSchema = Schema.Struct({
  search: Schema.optionalKey(Schema.NullOr(StoredEndpointSchema)),
  decision: Schema.optionalKey(Schema.NullOr(StoredEndpointSchema)),
  chat: Schema.optionalKey(Schema.NullOr(StoredChatEndpointSchema)),
  decisionSource: Schema.optionalKey(DecisionSourceSchema)
})

export type ModelEndpointSettingsPatch = typeof ModelEndpointSettingsPatchSchema.Type

export const DEFAULT_MODEL_ENDPOINT_SETTINGS: ModelEndpointSettings = {
  search: null,
  decision: null,
  chat: null,
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
