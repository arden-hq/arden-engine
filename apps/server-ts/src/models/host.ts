import type { ModelAssignment, ModelRole } from "@arden-hq/protocol/models"
import { Effect, Schema } from "effect"

const TextSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const EffortSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(128))
const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

const ModelContextLimitsSchema = Schema.Struct({
  hardLimit: PositiveIntSchema,
  compactionTrigger: PositiveIntSchema
}).check(
  Schema.makeFilter((limits) =>
    limits.compactionTrigger <= limits.hardLimit
      ? undefined
      : "compactionTrigger must not exceed hardLimit"
  )
)

const ModelDefinitionSchema = Schema.Struct({
  id: TextSchema,
  name: TextSchema,
  provider: Schema.Struct({
    id: TextSchema,
    name: TextSchema
  }),
  reasoningEfforts: Schema.UniqueArray(EffortSchema),
  context: ModelContextLimitsSchema
})

const ModelAssignmentSchema = Schema.Struct({
  modelId: Schema.NullOr(TextSchema),
  reasoningEffort: Schema.NullOr(EffortSchema)
})

const ModelHostDefaultsSchema = Schema.Struct({
  chatModelId: Schema.NullOr(TextSchema),
  /** Default reasoning effort for each model. Missing models have no default. */
  reasoningEfforts: Schema.Record(TextSchema, EffortSchema),
  /** A null role model inherits Chat; a null effort inherits the model default. */
  roles: Schema.Struct({
    background: ModelAssignmentSchema,
    helper: ModelAssignmentSchema
  } satisfies Record<ModelRole, typeof ModelAssignmentSchema>)
})

const ModelHostSchema = Schema.Struct({
  models: Schema.Array(ModelDefinitionSchema),
  defaults: ModelHostDefaultsSchema
}).check(
  Schema.makeFilter((host) => {
    const models = new Map(host.models.map((model) => [model.id, model]))
    if (models.size !== host.models.length) {
      return { path: ["models"], issue: "model IDs must be unique" }
    }

    const providers = new Map<string, string>()
    for (const model of host.models) {
      const providerName = providers.get(model.provider.id)
      if (providerName !== undefined && providerName !== model.provider.name) {
        return {
          path: ["models"],
          issue: `provider ${model.provider.id} must have one name`
        }
      }
      providers.set(model.provider.id, model.provider.name)
    }

    if (host.defaults.chatModelId !== null && !models.has(host.defaults.chatModelId)) {
      return { path: ["defaults", "chatModelId"], issue: "must reference a host model" }
    }

    for (const [modelId, effort] of Object.entries(host.defaults.reasoningEfforts)) {
      const model = models.get(modelId)
      if (model === undefined) {
        return {
          path: ["defaults", "reasoningEfforts", modelId],
          issue: "must reference a host model"
        }
      }
      if (!model.reasoningEfforts.includes(effort)) {
        return {
          path: ["defaults", "reasoningEfforts", modelId],
          issue: "must be supported by the model"
        }
      }
    }

    for (const [role, assignment] of Object.entries(host.defaults.roles)) {
      if (assignment.modelId === null) {
        if (assignment.reasoningEffort !== null) {
          return {
            path: ["defaults", "roles", role, "reasoningEffort"],
            issue: "requires a role model"
          }
        }
        continue
      }
      const model = models.get(assignment.modelId)
      if (model === undefined) {
        return {
          path: ["defaults", "roles", role, "modelId"],
          issue: "must reference a host model"
        }
      }
      if (
        assignment.reasoningEffort !== null &&
        !model.reasoningEfforts.includes(assignment.reasoningEffort)
      ) {
        return {
          path: ["defaults", "roles", role, "reasoningEffort"],
          issue: "must be supported by the role model"
        }
      }
    }

    return undefined
  })
)

const freezeAssignment = (assignment: ModelAssignment): ModelAssignment =>
  Object.freeze({
    modelId: assignment.modelId,
    reasoningEffort: assignment.reasoningEffort
  })

export type ModelContextLimits = typeof ModelContextLimitsSchema.Type
export type ModelDefinition = typeof ModelDefinitionSchema.Type
export type ModelHostDefaults = typeof ModelHostDefaultsSchema.Type
/** Immutable, credential-free model data supplied by the bundled host. */
export type ModelHost = typeof ModelHostSchema.Type

export type ModelHostSource =
  | { readonly kind: "ready"; readonly host: ModelHost }
  | { readonly kind: "discovering"; readonly host: Promise<ModelHost> }

const NO_MODEL_ASSIGNMENT: ModelAssignment = Object.freeze({
  modelId: null,
  reasoningEffort: null
})

const EMPTY_MODEL_HOST: ModelHost = Object.freeze({
  models: Object.freeze([]),
  defaults: Object.freeze({
    chatModelId: null,
    reasoningEfforts: Object.freeze({}),
    roles: Object.freeze({
      background: NO_MODEL_ASSIGNMENT,
      helper: NO_MODEL_ASSIGNMENT
    })
  })
})

const freezeHost = (host: ModelHost): ModelHost => {
  const roles: Readonly<Record<ModelRole, ModelAssignment>> = Object.freeze({
    background: freezeAssignment(host.defaults.roles.background),
    helper: freezeAssignment(host.defaults.roles.helper)
  })
  const defaults = Object.freeze({
    chatModelId: host.defaults.chatModelId,
    reasoningEfforts: Object.freeze({ ...host.defaults.reasoningEfforts }),
    roles
  })
  const models = Object.freeze(
    host.models.map((model) =>
      Object.freeze({
        id: model.id,
        name: model.name,
        provider: Object.freeze({ ...model.provider }),
        reasoningEfforts: Object.freeze([...model.reasoningEfforts]),
        context: Object.freeze({ ...model.context })
      })
    )
  )
  return Object.freeze({ models, defaults })
}

export const decodeModelHost = (value: unknown): Effect.Effect<ModelHost, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(ModelHostSchema)(value, { onExcessProperty: "error" }).pipe(
    Effect.map(freezeHost)
  )

export const decodeModelHostSource = (
  input: ModelHost | Promise<ModelHost> | undefined
): Effect.Effect<ModelHostSource, Schema.SchemaError> =>
  input instanceof Promise
    ? Effect.succeed({ kind: "discovering", host: input })
    : decodeModelHost(input ?? EMPTY_MODEL_HOST).pipe(
        Effect.map((host) => ({ kind: "ready", host }))
      )
